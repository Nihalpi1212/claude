//! Describe Image (`ai.describe`), and the two queries the interface and agents ask the backend:
//! `ai.status` (who is connected; never a key) and `ai.testConnection` (list a provider's models,
//! the one call that tests a key).

use serde_json::{Value, json};

use super::{call, check_keys, choice, generative_error, has_backend, prepare, prompt};
use crate::commands::CommandSpec;
use crate::generative::{BackendStatus, Describe, ModelKind, ProviderId, ProviderStatus, kind};
use crate::{EngineError, Result, Session};

const DESCRIBE: &str = "ai.describe";
const STATUS: &str = "ai.status";
const TEST: &str = "ai.testConnection";

/// The longest side of the image Describe sends (JS: 1024 for both providers).
const DESCRIBE_EDGE: u32 = 1024;

fn describe(s: &mut Session, p: &Value) -> Result<Value> {
    check_keys(DESCRIBE, p, &["prompt", "provider", "model"])?;
    let doc = s.active().ok_or(EngineError::NoDocument)?.doc.clone();
    let question = match p.get("prompt") {
        None | Some(Value::Null) => None,
        Some(Value::String(t)) if t.trim().is_empty() => None,
        Some(_) => Some(prompt(DESCRIBE, p, None)?),
    };
    let (backend, choice) = prepare(s, DESCRIBE, p, ModelKind::Chat)?;
    let provider = choice.provider.map(ProviderId::id);
    crate::jobs::run(
        s,
        "Describe Image",
        false,
        move |ctx| {
            ctx.progress(0.0, "Describing image");
            let image = photocraft_compose::thumbnail(&doc, DESCRIBE_EDGE);
            ctx.check()?;
            let req = Describe { choice, image, prompt: question };
            let text = call(ctx, |cancelled| backend.describe(&req, cancelled))?;
            let text = bounded(text.trim());
            if text.is_empty() {
                return Err(generative_error(kind::BAD_RESPONSE, "The model returned no description"));
            }
            Ok(text)
        },
        move |_, text| Ok(json!({ "text": text, "provider": provider })),
    )
}

/// `text` without control characters other than line breaks and tabs (they have no place in a
/// description or its XMP), cut to [`super::DESCRIBE_LIMIT`] characters with an ellipsis.
fn bounded(text: &str) -> String {
    let mut kept = text.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t'));
    let mut out: String = kept.by_ref().take(super::DESCRIBE_LIMIT).collect();
    if kept.next().is_some() {
        out.pop();
        out.push('…');
    }
    out
}

/// A key hint as `ai.status` shows it: an ellipsis and at most the last four characters, so even
/// a backend that put a whole key there would show no more.
fn safe_hint(hint: &str) -> String {
    let tail: Vec<char> = hint.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let tail: String = tail[tail.len().saturating_sub(4)..].iter().collect();
    format!("…{tail}")
}

fn provider_json(p: &ProviderStatus) -> Value {
    json!({
        "id": p.id.id(),
        "label": p.label,
        "connected": p.connected,
        "hint": p.hint.as_deref().filter(|h| !h.is_empty()).map(safe_hint),
        "store": p.store,
        "imageCapable": p.image_capable,
        "chatCapable": p.chat_capable,
        "imageModel": p.image_model,
        "chatModel": p.chat_model,
    })
}

/// `ai.status`'s answer for a backend's status (or none installed).
pub(super) fn status_json(status: Option<&BackendStatus>) -> Value {
    match status {
        None => json!({ "installed": false, "providers": [], "defaultProvider": null, "consented": false, "reason": super::NO_BACKEND }),
        Some(st) => json!({
            "installed": true,
            "providers": st.providers.iter().map(provider_json).collect::<Vec<_>>(),
            "defaultProvider": st.default_provider.map(ProviderId::id),
            "consented": st.consented,
        }),
    }
}

fn status(s: &mut Session, p: &Value) -> Result<Value> {
    check_keys(STATUS, p, &[])?;
    Ok(status_json(s.generative().map(|b| b.status()).as_ref()))
}

fn test_connection(s: &mut Session, p: &Value) -> Result<Value> {
    check_keys(TEST, p, &["provider"])?;
    let backend = super::admitted(s)?;
    let status = backend.status();
    let named = choice(TEST, p)?.provider;
    let connected = |id: ProviderId| status.provider(id).is_some_and(|p| p.connected);
    // Listing models sends the key, not prompts or pixels: no consent needed.
    let provider = match named {
        Some(id) if connected(id) => id,
        Some(id) => return Err(generative_error(kind::MISSING_KEY, format!("{} is not connected. Add an API key in Edit › AI Accounts…", id.label()))),
        None => status
            .default_provider
            .into_iter()
            .chain(ProviderId::ALL)
            .find(|id| connected(*id))
            .ok_or_else(|| generative_error(kind::MISSING_KEY, "No AI provider is connected. Add an API key in Edit › AI Accounts…"))?,
    };
    crate::jobs::run(
        s,
        "Test Connection",
        false,
        move |ctx| call(ctx, |cancelled| backend.list_models(provider, cancelled)),
        move |_, models| {
            Ok(json!({
                "provider": provider.id(),
                "models": models.iter().map(|(id, kind)| json!({ "id": id, "kind": kind })).collect::<Vec<_>>(),
            }))
        },
    )
}

fn describe_enabled(s: &Session) -> std::result::Result<(), String> {
    s.active().ok_or("no document open")?;
    has_backend(s)
}

pub(super) fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: DESCRIBE,
            label: "Describe Image…",
            menu: &[],
            shortcut: None,
            params: r##"{"prompt":str? (what to ask; default a plain-prose description),"provider":"openai|gemini"?,"model":str?} → {text,provider} (sends the composite, at most 1024 px a side, to the AI provider's chat model; changes nothing)"##,
            enabled: describe_enabled,
            run: describe,
            journal: false,
        },
        CommandSpec {
            id: STATUS,
            label: "AI Status",
            menu: &[],
            shortcut: None,
            params: r##"{} → {installed,providers:[{id,label,connected,hint,store,imageCapable,chatCapable,imageModel,chatModel}],defaultProvider,consented} (never a key: hint is at most its last four characters)"##,
            enabled: |_| Ok(()),
            run: status,
            journal: false,
        },
        CommandSpec {
            id: TEST,
            label: "Test AI Connection",
            menu: &[],
            shortcut: None,
            params: r##"{"provider":"openai|gemini"? (default the preferred connected provider)} → {provider,models:[{id,kind}]} (lists the provider's models with the stored key; sends no prompt or image)"##,
            enabled: has_backend,
            run: test_connection,
            journal: false,
        },
    ]
}
