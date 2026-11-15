//! Chat with function tools, the parts both providers share (JS `providers.js`): the JSON schema
//! Gemini accepts ([`clean_schema`], [`gemini_schema`], [`gemini_declaration`]), tool arguments
//! that arrive as JSON text ([`parse_args`]), tool results sent back as text ([`result_text`]),
//! and Describe's request ([`describe_request`]).
//!
//! The backend runs **one round** per `chat` call; the tool loop lives in the caller (the
//! Assistant), because tools run on the interface thread. A model turn comes back with an opaque
//! `provider_state` (`{"provider":"openai","items":[…]}` or `{"provider":"gemini","parts":[…]}`)
//! that the next round sends back verbatim, as each provider needs for tool calls (OpenAI's output
//! items, Gemini's parts with their thought signatures). A turn from the other provider (the person
//! switched provider mid-conversation) goes back as plain text instead.

use photocraft_engine::generative::{ChatMessage, ChatRequest, Choice, Describe};
use serde_json::{Map, Value, json};

/// What Describe asks when the person asks nothing (JS `describeImage`).
pub const DESCRIBE_PROMPT: &str =
    "Describe this image in detail: subject, composition, colours, lighting, mood and any text it contains. Answer in plain prose.";

/// Describe as a chat round: one user message with the image, no tools.
pub fn describe_request(req: &Describe) -> ChatRequest {
    let text = req.prompt.as_deref().map(str::trim).filter(|p| !p.is_empty()).unwrap_or(DESCRIBE_PROMPT).to_string();
    ChatRequest {
        choice: Choice { provider: req.choice.provider, model: req.choice.model.clone() },
        instructions: String::new(),
        messages: vec![ChatMessage::User { text, images: vec![req.image.clone()] }],
        tools: vec![],
    }
}

/// Tool arguments as the model sent them: an object as is, JSON text parsed, unreadable text kept
/// as `{"_raw": text}` (JS `parseArgs`), nothing as `{}`.
pub fn parse_args(raw: &Value) -> Value {
    match raw {
        Value::Object(_) => raw.clone(),
        Value::String(s) if !s.trim().is_empty() => serde_json::from_str(s).unwrap_or_else(|_| json!({ "_raw": s })),
        _ => json!({}),
    }
}

/// A tool result as the text OpenAI's `function_call_output` takes: a string as is, anything else
/// as JSON (JS `resultText`).
pub fn result_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The JSON-schema keys Gemini refuses, dropped at every level (JS `cleanSchema`).
pub fn clean_schema(schema: &Value) -> Value {
    match schema {
        Value::Array(a) => Value::Array(a.iter().map(clean_schema).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| !matches!(k.as_str(), "$schema" | "additionalProperties" | "default" | "examples" | "$id" | "strict"))
                .map(|(k, v)| (k.clone(), clean_schema(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn as_json_string(desc: Option<&str>, what: &str) -> Value {
    let d = desc.map(str::trim).filter(|d| !d.is_empty());
    json!({ "type": "string", "description": match d { Some(d) => format!("{d} ({what}, as a JSON string)"), None => format!("({what}, as a JSON string)") } })
}

/// Gemini's schema subset (JS `geminiSchema`): every schema has a `type`; an object without
/// properties and an untyped value travel as JSON strings (the tools parse them back); arrays
/// have `items` (string by default); a type list takes its first non-null type; `required` names
/// only existing properties.
pub fn gemini_schema(schema: &Value) -> Value {
    let s = clean_schema(schema);
    let Value::Object(o) = &s else { return s };
    let desc = o.get("description").and_then(Value::as_str);
    let ty = o.get("type");
    if ty.and_then(Value::as_str) == Some("object") || o.contains_key("properties") {
        let props = o.get("properties").and_then(Value::as_object).cloned().unwrap_or_default();
        if props.is_empty() {
            return as_json_string(desc, "an object");
        }
        let mut out = o.clone();
        out.insert("type".into(), json!("object"));
        out.insert("properties".into(), Value::Object(props.iter().map(|(k, v)| (k.clone(), gemini_schema(v))).collect::<Map<_, _>>()));
        if let Some(req) = o.get("required").and_then(Value::as_array) {
            out.insert("required".into(), Value::Array(req.iter().filter(|k| k.as_str().is_some_and(|k| props.contains_key(k))).cloned().collect()));
        }
        return Value::Object(out);
    }
    if ty.and_then(Value::as_str) == Some("array") {
        let mut out = o.clone();
        out.insert("items".into(), o.get("items").map(gemini_schema).unwrap_or_else(|| json!({ "type": "string" })));
        return Value::Object(out);
    }
    if let Some(Value::Array(types)) = ty {
        let mut out = o.clone();
        let first = types.iter().filter_map(Value::as_str).find(|t| *t != "null").unwrap_or("string");
        out.insert("type".into(), json!(first));
        return Value::Object(out);
    }
    if ty.is_none() {
        return as_json_string(desc, "any value");
    }
    s
}

/// One Gemini function declaration (JS `geminiDeclaration`); a tool without parameters declares
/// none (Gemini refuses an empty object).
pub fn gemini_declaration(name: &str, description: &str, parameters: &Value) -> Value {
    let mut decl = json!({ "name": name, "description": description });
    let p = if parameters.is_null() { json!({ "type": "object", "properties": {} }) } else { gemini_schema(parameters) };
    if p.get("type").and_then(Value::as_str) == Some("object") && p.get("properties").and_then(Value::as_object).is_some_and(|m| !m.is_empty()) {
        decl["parameters"] = p;
    }
    decl
}
