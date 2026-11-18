//! Pigment: `pigment-cli ai`, the AI Accounts of the command line (docs/generative-ai.md): keys,
//! the experimental Sign in with ChatGPT (chat models only), consent, the preferred provider and
//! its models, and whether agents may run AI commands. Keys
//! are read from standard input, never from the command line (where the shell history and the
//! process list would keep them), and never printed: the status shows the last four characters.
//! `pigment-cli run --allow-ai` is what lets `run` send ([`install`]).

use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;

use clap::{Args, Subcommand};
use photocraft_automation::Headless;
use pigment_genai::cancel::never;
use pigment_genai::provider::{ModelInfo, ModelKind};
use pigment_genai::{AiAccounts, Caller, ProviderId};
use serde_json::{Value, json};

use crate::args::{RunArgs, Step};
use crate::output::{JsonStyle, print_json};
use crate::{CliError, Result};

/// Set up generative AI: API keys, consent, the preferred provider and models, agents
///
/// Pigment's AI commands (`ai.generativeFill` and the others, run with `run --allow-ai`) send your
/// prompt and, where a feature needs it, the image or selection to the AI provider you chose,
/// billed to your account. These settings are the ones Edit › AI Accounts… shows.
#[derive(Args)]
pub(crate) struct AiArgs {
    #[command(subcommand)]
    pub(crate) command: AiCommand,
}

#[derive(Subcommand)]
pub(crate) enum AiCommand {
    /// Show the connected providers, their models, consent and whether agents may run AI
    /// commands (never a key: at most its last four characters)
    Status {
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
    /// Store a provider's API key, read from standard input (typed without echo at a terminal).
    /// The provider checks it first (it lists its models); a key it refuses is not stored
    SetKey {
        /// openai or gemini
        #[arg(value_parser = provider)]
        provider: ProviderId,
        /// Refused: a key on the command line stays in the shell history and the process list
        #[arg(hide = true)]
        key: Option<String>,
        /// Store the key without asking the provider
        #[arg(long)]
        no_check: bool,
    },
    /// Remove a provider's API key
    ClearKey {
        /// openai or gemini
        #[arg(value_parser = provider)]
        provider: ProviderId,
    },
    /// Sign in with ChatGPT (experimental): use a ChatGPT Plus or Pro plan for chat models (the
    /// Assistant, Describe Image). Image models still need an API key. Prints an address to open
    /// in a browser and waits for the sign-in to finish there (five minutes at most). With a
    /// browser on another computer, paste the address it lands on at the prompt
    SignIn {
        /// The port on 127.0.0.1 to listen on for the browser (default: the first free one of
        /// 1455 to 1460)
        #[arg(long, value_name = "PORT")]
        port: Option<u16>,
    },
    /// Sign out of ChatGPT: the sign-in is removed from this computer (nothing is revoked at
    /// OpenAI)
    SignOut,
    /// List a provider's models with its stored key (sends the key, no prompt or image)
    Test {
        /// openai or gemini (default: the preferred connected provider)
        #[arg(value_parser = provider)]
        provider: Option<ProviderId>,
        /// Print JSON
        #[arg(long)]
        json: bool,
    },
    /// Agree that AI commands send your prompt and, where a feature needs it, the image or
    /// selection to your AI provider, billed to your account. Nothing is sent before
    Consent {
        /// Withdraw the agreement
        #[arg(long)]
        revoke: bool,
    },
    /// Let agents (MCP, the control channel, `pigment-cli serve`) run AI commands, which are
    /// billed to your account: on or off
    Agents {
        #[arg(value_name = "on|off", value_parser = on_off, action = clap::ArgAction::Set)]
        state: bool,
    },
    /// Make a provider the preferred one, and optionally choose its models ("" for automatic:
    /// the provider's preferred model)
    Use {
        /// openai or gemini
        #[arg(value_parser = provider)]
        provider: ProviderId,
        /// The chat model (the Assistant, Describe)
        #[arg(long, value_name = "ID")]
        chat_model: Option<String>,
        /// The image model (Generative Fill, Generate Image, …)
        #[arg(long, value_name = "ID")]
        image_model: Option<String>,
    },
}

fn provider(s: &str) -> std::result::Result<ProviderId, String> {
    ProviderId::parse(&s.to_ascii_lowercase()).ok_or_else(|| "expected openai or gemini".to_string())
}

fn on_off(s: &str) -> std::result::Result<bool, String> {
    match s {
        "on" => Ok(true),
        "off" => Ok(false),
        _ => Err("expected on or off".into()),
    }
}

/// The consent wording, as AI Accounts shows it.
pub(crate) const CONSENT: &str = "Generative AI sends your prompt and, where a feature needs it, the image or selection to the AI provider you chose (OpenAI or Google Gemini), billed to your account. A request you stop may still be billed.";

/// `run`'s check before any work: a step that may send to an AI provider (and so be billed)
/// needs `--allow-ai`. With it, the session gets a backend that may send; without, nested steps
/// (an action that plays `ai.*`) are refused by the backend too.
pub(crate) fn install(h: &mut Headless, a: &RunArgs) -> Result {
    let mut steps: Vec<(&str, Value)> = Vec::new();
    for step in &a.steps {
        match step {
            Step::Cmd(id) => steps.push((id, json!({}))),
            Step::Params(p) => {
                if let Some(last) = steps.last_mut() {
                    last.1 = p.clone();
                }
            }
        }
    }
    if !a.allow_ai
        && let Some((id, _)) = steps.iter().find(|(id, p)| photocraft_engine::ai_cmds::may_send(id, p))
    {
        return Err(CliError::Other(format!(
            "`{id}` sends your image or prompt to your AI provider, billed to your account: add --allow-ai to run it (set the provider up with `pigment-cli ai`)"
        )));
    }
    photocraft_automation::genai::install(&mut h.session, Caller::CommandLine { allow_ai: a.allow_ai });
    Ok(())
}

fn ai_error(e: pigment_genai::AiError) -> CliError {
    CliError::Other(e.message)
}

fn config_dir() -> Result<PathBuf> {
    photocraft_automation::app_dirs::from_env()
        .dir
        .ok_or_else(|| CliError::Other("Pigment's settings folder is unknown here (no home folder): set PHOTOCRAFT_CONFIG_DIR".into()))
}

fn models_json(models: &[ModelInfo]) -> Value {
    Value::Array(models.iter().map(|m| json!({ "id": m.id, "kind": m.kind.engine_id() })).collect())
}

fn ids(models: &[ModelInfo], kind: ModelKind) -> String {
    let v: Vec<&str> = models.iter().filter(|m| m.kind == kind).map(|m| m.id.as_str()).collect();
    if v.is_empty() { "none".into() } else { v.join(", ") }
}

pub(crate) fn run(a: &AiArgs, out: &mut dyn Write, err: &mut dyn Write) -> Result {
    let dir = config_dir()?;
    let mut accounts = AiAccounts::new(&dir);
    match &a.command {
        AiCommand::Status { json } => status(&accounts, &dir, *json, out),
        AiCommand::SetKey { provider, key, no_check } => {
            if key.is_some() {
                return Err(CliError::Other(
                    "a key on the command line stays in the shell history and the process list: pipe it on standard input instead, or run `pigment-cli ai set-key <provider>` and paste it".into(),
                ));
            }
            let key = read_key(*provider, err)?;
            if *no_check {
                accounts.set_key(*provider, &key).map_err(ai_error)?;
                writeln!(out, "{} key stored in {} (not checked).", provider.label(), accounts.store_backend())?;
            } else {
                let models = accounts.connect(*provider, &key, &never).map_err(ai_error)?;
                writeln!(out, "{} connected; the key is kept in {}.", provider.label(), accounts.store_backend())?;
                writeln!(out, "  chat models: {}\n  image models: {}", ids(&models, ModelKind::Chat), ids(&models, ModelKind::Image))?;
            }
            if !accounts.settings.consented {
                writeln!(out, "Before AI commands run, agree to what they send: pigment-cli ai consent")?;
            }
            Ok(())
        }
        AiCommand::ClearKey { provider } => {
            accounts.clear_key(*provider).map_err(ai_error)?;
            writeln!(out, "{} key removed.", provider.label())?;
            if accounts.method(*provider) == Some(pigment_genai::Method::Chatgpt) {
                writeln!(out, "{} is still signed in with ChatGPT: `pigment-cli ai sign-out` removes that.", provider.label())?;
            }
            Ok(())
        }
        AiCommand::SignIn { port } => sign_in(&mut accounts, *port, out, err),
        AiCommand::SignOut => {
            if accounts.method(ProviderId::OpenAi) != Some(pigment_genai::Method::Chatgpt) {
                accounts.chatgpt().cancel();
                writeln!(out, "Not signed in with ChatGPT.")?;
                return Ok(());
            }
            accounts.sign_out().map_err(ai_error)?;
            writeln!(out, "Signed out of ChatGPT.")?;
            Ok(())
        }
        AiCommand::Test { provider, json } => {
            let p = provider
                .or_else(|| accounts.default_provider())
                .ok_or_else(|| CliError::Other("no AI provider is connected: run `pigment-cli ai set-key openai` (or gemini)".into()))?;
            let models = accounts.test_connection(p, &never).map_err(ai_error)?;
            if *json {
                print_json(out, &json!({ "provider": p.id(), "models": models_json(&models) }), JsonStyle::Pretty)
            } else {
                let what = if accounts.method(p) == Some(pigment_genai::Method::Chatgpt) { "the ChatGPT sign-in" } else { "the key" };
                writeln!(out, "{}: {what} works ({} models).", p.label(), models.len())?;
                writeln!(out, "  chat models: {}\n  image models: {}", ids(&models, ModelKind::Chat), ids(&models, ModelKind::Image))?;
                Ok(())
            }
        }
        AiCommand::Consent { revoke } => {
            accounts.set_consented(!revoke).map_err(ai_error)?;
            if *revoke {
                writeln!(out, "Agreement withdrawn: AI commands send nothing until you agree again.")?;
            } else {
                writeln!(out, "{CONSENT}\nRecorded: you agreed.")?;
            }
            Ok(())
        }
        AiCommand::Agents { state } => {
            accounts.set_allow_agents(*state).map_err(ai_error)?;
            writeln!(out, "{}", if *state { "Agents may now run AI commands, billed to your account." } else { "Agents may no longer run AI commands." })?;
            Ok(())
        }
        AiCommand::Use { provider, chat_model, image_model } => {
            accounts.set_models(*provider, chat_model.as_deref(), image_model.as_deref()).map_err(ai_error)?;
            accounts.set_default_provider(*provider).map_err(ai_error)?;
            let (chat, auto_chat) = accounts.shown_model(*provider, ModelKind::Chat);
            let (image, auto_image) = accounts.shown_model(*provider, ModelKind::Image);
            let auto = |a: bool| if a { " (automatic)" } else { "" };
            writeln!(out, "{} is the preferred provider; chat model {chat}{}, image model {image}{}.", provider.label(), auto(auto_chat), auto(auto_image))?;
            Ok(())
        }
    }
}

/// `ai sign-in`: start the attempt, print the address to open, and wait for the browser's
/// callback (or the address pasted on standard input) until the sign-in ends.
fn sign_in(accounts: &mut AiAccounts, port: Option<u16>, out: &mut dyn Write, err: &mut dyn Write) -> Result {
    let started = accounts.sign_in(port).map_err(ai_error)?;
    let url = started.url.unwrap_or_default();
    writeln!(out, "Sign in with ChatGPT (experimental): a ChatGPT Plus or Pro plan for chat models. Image models need an API key.")?;
    writeln!(out, "Open this address in a browser and sign in:\n\n  {url}\n")?;
    if let Some(warning) = &started.warning {
        writeln!(out, "{warning}")?;
    }
    // AI Accounts hides the sign-in while a key is connected; here the person is told first.
    if accounts.method(ProviderId::OpenAi) == Some(pigment_genai::Method::ApiKey) {
        writeln!(
            out,
            "OpenAI has an API key stored, and signing in replaces it: image models then need the key again (pigment-cli ai set-key openai). Press Ctrl+C now to keep the key."
        )?;
    }
    writeln!(out, "Waiting for the browser (5 minutes at most). With a browser on another computer, paste the address it lands on here and press Enter.")?;
    out.flush()?;
    // A pasted address, read on its own thread so the wait below also sees the browser's callback.
    let chatgpt = std::sync::Arc::clone(accounts.chatgpt());
    let (pasted, refused) = (std::sync::Arc::clone(&chatgpt), std::sync::mpsc::channel::<String>());
    let (tx, rx) = refused;
    let reader = std::thread::Builder::new().name("pigment-ai-sign-in-stdin".into()).spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if !pasted.status().pending {
                break;
            }
            if line.trim().is_empty() {
                continue;
            }
            // An address that is refused while the attempt goes on (another attempt's, an
            // unreadable one) is said and the wait goes on; a failure that ends the attempt is
            // the command's own error.
            if let Err(e) = pasted.complete_manual(&line)
                && pasted.status().pending
                && tx.send(e.message).is_err()
            {
                break;
            }
        }
    });
    if reader.is_err() {
        writeln!(err, "(standard input can't be read here: finish the sign-in in the browser on this computer)")?;
    }
    let outcome = loop {
        while let Ok(message) = rx.try_recv() {
            writeln!(err, "{message}")?;
        }
        if let Some(outcome) = chatgpt.take_outcome() {
            break outcome;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    while let Ok(message) = rx.try_recv() {
        writeln!(err, "{message}")?;
    }
    let who = outcome.map_err(ai_error)?;
    let named = who.email.as_deref().map(|e| format!(" as {e}")).unwrap_or_default();
    writeln!(out, "Signed in with ChatGPT{named}. The sign-in is kept in {}.", accounts.store_backend())?;
    if who.plan == Some(false) {
        writeln!(out, "The sign-in did not grant plan access: chat requests may be refused. An OpenAI API key works instead.")?;
    }
    if !accounts.settings.consented {
        writeln!(out, "Before AI commands run, agree to what they send: pigment-cli ai consent")?;
    }
    Ok(())
}

fn status(accounts: &AiAccounts, dir: &std::path::Path, json: bool, out: &mut dyn Write) -> Result {
    let s = &accounts.settings;
    let rows = accounts.status();
    let key_file = (accounts.store_backend() == pigment_genai::keys::FILE_BACKEND).then(|| dir.join(pigment_genai::keys::KEY_FILE));
    if json {
        let v = json!({
            "providers": rows,
            "defaultProvider": accounts.default_provider().map(ProviderId::id),
            "consented": s.consented,
            "allowAgents": s.allow_agents,
            "store": accounts.store_backend(),
            "keyFile": key_file,
            "settingsFile": pigment_genai::AiSettings::path(dir),
        });
        return print_json(out, &v, JsonStyle::Pretty);
    }
    let agreed = if s.consented { "given" } else { "not given (pigment-cli ai consent)" };
    writeln!(out, "Agreement to send prompts and images: {agreed}")?;
    writeln!(out, "Agents may run AI commands: {}", if s.allow_agents { "yes" } else { "no (pigment-cli ai agents on)" })?;
    match &key_file {
        Some(f) => writeln!(out, "Keys are kept in {} ({}).", accounts.store_backend(), f.display())?,
        None => writeln!(out, "Keys are kept in the {}.", accounts.store_backend())?,
    }
    for r in rows {
        let state = match r.method {
            Some(pigment_genai::Method::Chatgpt) => {
                let who = r.email.as_deref().map(|e| format!(" as {e}")).unwrap_or_default();
                let plan = if r.plan == Some(false) { ", plan access not granted" } else { "" };
                format!("signed in with ChatGPT{who} (experimental; chat models only, image models need an API key{plan})")
            }
            Some(pigment_genai::Method::ApiKey) if r.hint.is_empty() => "connected with an API key".to_string(),
            Some(pigment_genai::Method::ApiKey) => format!("connected (…{})", r.hint),
            None => "not connected".to_string(),
        };
        let preferred = if r.is_default { ", preferred" } else { "" };
        writeln!(out, "{}: {state}{preferred}", r.label)?;
        let auto = |a: bool| if a { " (automatic)" } else { "" };
        writeln!(out, "  chat model: {}{}\n  image model: {}{}", r.chat_model, auto(r.chat_model_automatic), r.image_model, auto(r.image_model_automatic))?;
    }
    Ok(())
}

/// The key from standard input: at a terminal, typed or pasted without echo (Unix; elsewhere it
/// shows, and the prompt says so); otherwise the first line of what is piped in.
fn read_key(p: ProviderId, err: &mut dyn Write) -> Result<String> {
    let stdin = std::io::stdin();
    let terminal = stdin.is_terminal();
    let echo_off = terminal && set_echo(false);
    if terminal {
        let note = if echo_off { "" } else { " (it will show as you type)" };
        write!(err, "Paste the {} API key and press Enter{note}: ", p.label())?;
        err.flush()?;
    }
    let mut line = String::new();
    let read = stdin.lock().read_line(&mut line);
    if echo_off {
        set_echo(true);
        writeln!(err)?;
    }
    read?;
    let key = line.trim().to_string();
    if key.is_empty() {
        return Err(CliError::Other("no key on standard input: pipe it in, or paste it at the prompt".into()));
    }
    Ok(key)
}

/// Turn the terminal's echo off or on with `stty`; whether it worked.
fn set_echo(on: bool) -> bool {
    if !cfg!(unix) {
        return false;
    }
    std::process::Command::new("stty")
        .arg(if on { "echo" } else { "-echo" })
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
