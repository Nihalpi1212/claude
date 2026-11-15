//! Chat with function tools: Gemini's schema subset, both providers' request bodies and answers,
//! history sent back verbatim (OpenAI items, Gemini parts with thought signatures), a provider
//! switch mid-conversation, and the two-round tool loop end to end through the backend.

use photocraft_engine::generative::{ChatMessage, ChatRequest, ChatTurn, Choice, Describe, GenerativeBackend, ToolResult, ToolSpec};
use pigment_genai::Caller;
use pigment_genai::chat::{DESCRIBE_PROMPT, clean_schema, describe_request, gemini_declaration, gemini_schema, parse_args, result_text};
use pigment_genai::provider::{gemini, openai};
use serde_json::{Value, json};

use crate::common::{MockServer, Reply, accounts, backend, gemini_text, inline_image, openai_text, px, solid};

fn tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "run_command".into(),
            description: "Run an engine command".into(),
            parameters: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "id": {"type": "string", "description": "The command id", "examples": ["image.crop"]},
                    "params": {"type": "object", "description": "Its parameters"},
                    "value": {"description": "Anything"},
                    "ids": {"type": "array"},
                    "opacity": {"type": ["null", "number"], "default": null}
                },
                "required": ["id", "missing"]
            }),
        },
        ToolSpec { name: "get_document".into(), description: "Describe the document".into(), parameters: json!({"type": "object", "properties": {}}) },
    ]
}

#[test]
fn gemini_gets_its_schema_subset() {
    let p = &tools()[0].parameters;
    let cleaned = clean_schema(p);
    assert!(cleaned.get("$schema").is_none() && cleaned.get("additionalProperties").is_none());
    assert!(cleaned["properties"]["id"].get("examples").is_none());
    let g = gemini_schema(p);
    assert_eq!(g["type"], "object");
    assert_eq!(g["properties"]["id"], json!({"type": "string", "description": "The command id"}));
    assert_eq!(g["properties"]["params"], json!({"type": "string", "description": "Its parameters (an object, as a JSON string)"}));
    assert_eq!(g["properties"]["value"], json!({"type": "string", "description": "Anything (any value, as a JSON string)"}));
    assert_eq!(g["properties"]["ids"], json!({"type": "array", "items": {"type": "string"}}));
    assert_eq!(g["properties"]["opacity"], json!({"type": "number"}));
    assert_eq!(g["required"], json!(["id"]), "only existing properties stay required");
    // A tool without parameters declares none (Gemini refuses an empty object).
    assert_eq!(gemini_declaration("get_document", "Describe the document", &tools()[1].parameters), json!({"name": "get_document", "description": "Describe the document"}));
    assert_eq!(gemini_declaration("t", "", &Value::Null), json!({"name": "t", "description": ""}));
    // Arguments that arrive as JSON text are parsed; unreadable text is kept; results go back as text.
    assert_eq!(parse_args(&json!("{\"id\":\"x\"}")), json!({"id": "x"}));
    assert_eq!(parse_args(&json!("not json")), json!({"_raw": "not json"}));
    assert_eq!(parse_args(&Value::Null), json!({}));
    assert_eq!((result_text(&json!("done")), result_text(&json!({"ok": true}))), ("done".to_string(), "{\"ok\":true}".to_string()));
}

fn request(messages: Vec<ChatMessage>) -> ChatRequest {
    ChatRequest { choice: Choice::default(), instructions: "You edit images.".into(), messages, tools: tools() }
}

#[test]
fn openai_chat_bodies_and_turns() {
    let picture = solid(3, 2, [200, 10, 10, 255]);
    let b = openai::chat_body(
        "gpt-5.1",
        &request(vec![ChatMessage::User { text: "Crop it".into(), images: vec![picture] }, ChatMessage::Assistant { text: "Sure.".into() }]),
    )
    .unwrap();
    assert_eq!(b["model"], "gpt-5.1");
    assert_eq!(b["store"], false);
    assert_eq!(b["instructions"], "You edit images.");
    assert_eq!(b["tool_choice"], "auto");
    assert_eq!(b["tools"][0]["type"], "function");
    assert_eq!(b["tools"][0]["strict"], false);
    assert_eq!(b["tools"][0]["parameters"], tools()[0].parameters, "OpenAI gets the schema as given");
    let input = b["input"].as_array().unwrap();
    assert_eq!(input[0]["content"][0], json!({"type": "input_text", "text": "Crop it"}));
    assert_eq!(input[0]["content"][1]["type"], "input_image");
    assert!(input[0]["content"][1]["image_url"].as_str().unwrap().starts_with("data:image/png;base64,"));
    assert_eq!(input[1], json!({"role": "assistant", "content": [{"type": "output_text", "text": "Sure."}]}));
    // An empty message still sends one input_text; no tools, no tool fields.
    let empty = openai::chat_body("m", &ChatRequest { tools: vec![], ..request(vec![ChatMessage::User { text: String::new(), images: vec![] }]) }).unwrap();
    assert_eq!(empty["input"][0]["content"], json!([{"type": "input_text", "text": ""}]));
    assert!(empty.get("tools").is_none() && empty.get("tool_choice").is_none());

    let answer = json!({"output": [
        {"type": "reasoning", "id": "rs_1", "summary": []},
        {"type": "function_call", "id": "fc_1", "call_id": "call_A", "name": "run_command", "arguments": "{\"id\":\"image.crop\"}"},
        {"type": "function_call", "id": "fc_2", "call_id": "call_B", "name": "get_document", "arguments": "oops"},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Working."}]}
    ]});
    let turn = openai::parse_turn(&answer).unwrap();
    assert_eq!(turn.text, "Working.");
    assert_eq!(turn.tool_calls.len(), 2);
    assert_eq!((turn.tool_calls[0].id.as_str(), turn.tool_calls[0].arguments.clone()), ("call_A", json!({"id": "image.crop"})));
    assert_eq!(turn.tool_calls[1].arguments, json!({"_raw": "oops"}));
    let items = turn.provider_state["items"].as_array().unwrap();
    assert_eq!(items.len(), 3, "the reasoning item without encrypted content is dropped");
    assert_eq!(items[0], json!({"type": "function_call", "call_id": "call_A", "name": "run_command", "arguments": "{\"id\":\"image.crop\"}"}));
    // The next round sends the items back, then one output per call.
    let next = openai::chat_body(
        "gpt-5.1",
        &request(vec![
            ChatMessage::User { text: "Crop it".into(), images: vec![] },
            ChatMessage::Turn(turn),
            ChatMessage::ToolResults(vec![
                ToolResult { call_id: "call_A".into(), name: "run_command".into(), output: json!({"ok": true}) },
                ToolResult { call_id: "call_B".into(), name: "get_document".into(), output: json!("a 400 × 300 document") },
            ]),
        ]),
    )
    .unwrap();
    let input = next["input"].as_array().unwrap();
    assert_eq!(input.len(), 6);
    assert_eq!(input[4], json!({"type": "function_call_output", "call_id": "call_A", "output": "{\"ok\":true}"}));
    assert_eq!(input[5]["output"], "a 400 × 300 document");
    let refused = json!({"output": [{"type": "message", "content": [{"type": "refusal", "refusal": "No."}]}]});
    assert_eq!(openai::parse_turn(&refused).unwrap_err().kind, pigment_genai::ErrorKind::Safety);
    assert_eq!(openai::parse_turn(&json!({"error": {"message": "bad"}})).unwrap_err().message, "OpenAI: bad");
}

#[test]
fn gemini_chat_bodies_and_turns() {
    let b = gemini::chat_body(&request(vec![
        ChatMessage::User { text: "Crop it".into(), images: vec![solid(2, 2, [1, 2, 3, 255])] },
        ChatMessage::Assistant { text: "Sure.".into() },
    ]))
    .unwrap();
    assert_eq!(b["systemInstruction"], json!({"parts": [{"text": "You edit images."}]}));
    let decls = b["tools"][0]["functionDeclarations"].as_array().unwrap();
    assert_eq!(decls.len(), 2);
    assert_eq!(decls[0]["parameters"]["properties"]["params"]["type"], "string");
    assert!(decls[1].get("parameters").is_none());
    assert_eq!(b["contents"][0]["role"], "user");
    assert_eq!(px(&inline_image(&b["contents"][0]["parts"][1]), 1, 1), [1, 2, 3, 255]);
    assert_eq!(b["contents"][1], json!({"role": "model", "parts": [{"text": "Sure."}]}));

    let parts = json!([
        {"text": "planning", "thought": true},
        {"functionCall": {"name": "run_command", "args": {"id": "image.crop"}}, "thoughtSignature": "c2lnbmF0dXJl"},
        {"functionCall": {"name": "get_document"}}
    ]);
    let answer = json!({"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}]});
    let turn = gemini::parse_turn(&answer).unwrap();
    assert_eq!(turn.text, "", "thoughts are not the answer");
    assert_eq!(turn.tool_calls.len(), 2);
    assert_eq!(turn.tool_calls[0].arguments, json!({"id": "image.crop"}));
    assert_eq!(turn.tool_calls[1].arguments, json!({}));
    assert_ne!(turn.tool_calls[0].id, turn.tool_calls[1].id);
    let next = gemini::chat_body(&request(vec![
        ChatMessage::User { text: "Crop it".into(), images: vec![] },
        ChatMessage::Turn(turn),
        ChatMessage::ToolResults(vec![ToolResult { call_id: "gemini-call-0".into(), name: "run_command".into(), output: json!({"ok": true}) }]),
    ]))
    .unwrap();
    let contents = next["contents"].as_array().unwrap();
    assert_eq!(contents[1], json!({"role": "model", "parts": parts}), "the model turn goes back verbatim, thought signature included");
    assert_eq!(contents[2], json!({"role": "user", "parts": [{"functionResponse": {"name": "run_command", "response": {"result": {"ok": true}}}}]}));
}

/// A turn from the other provider can't be replayed as its items: it goes back as text.
#[test]
fn a_provider_switch_sends_the_earlier_turn_as_text() {
    let openai_turn = openai::parse_turn(&json!({"output": [
        {"type": "function_call", "call_id": "call_A", "name": "run_command", "arguments": "{}"},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Cropping."}]}
    ]}))
    .unwrap();
    let history = vec![
        ChatMessage::User { text: "Crop it".into(), images: vec![] },
        ChatMessage::Turn(openai_turn),
        ChatMessage::ToolResults(vec![ToolResult { call_id: "call_A".into(), name: "run_command".into(), output: json!("done") }]),
    ];
    let g = gemini::chat_body(&request(history.clone())).unwrap();
    let contents = g["contents"].as_array().unwrap();
    assert_eq!(contents[1]["role"], "model");
    assert!(contents[1]["parts"][0]["text"].as_str().unwrap().contains("[called run_command({})]"));
    assert!(contents[2]["parts"][0]["text"].as_str().unwrap().starts_with("Tool results: "));
    assert!(!g.to_string().contains("functionResponse") && !g.to_string().contains("call_A"));
    let gemini_turn = gemini::parse_turn(&gemini_text("Hello")).unwrap();
    let o = openai::chat_body("m", &request(vec![ChatMessage::Turn(gemini_turn)])).unwrap();
    assert_eq!(o["input"][0], json!({"role": "assistant", "content": [{"type": "output_text", "text": "Hello"}]}));
}

#[test]
fn describe_is_one_chat_round_with_the_image() {
    let req = describe_request(&Describe { choice: Choice::default(), image: solid(4, 4, [0, 0, 0, 255]), prompt: None });
    assert!(req.tools.is_empty());
    match &req.messages[..] {
        [ChatMessage::User { text, images }] => {
            assert_eq!(text, DESCRIBE_PROMPT);
            assert_eq!(images.len(), 1);
        }
        other => panic!("{other:?}"),
    }
    let asked = describe_request(&Describe { choice: Choice::default(), image: solid(1, 1, [0; 4]), prompt: Some("What text is there?".into()) });
    assert!(matches!(&asked.messages[0], ChatMessage::User { text, .. } if text == "What text is there?"));
}

/// The Assistant's loop as the interface will run it: round one asks for a tool, the tool runs,
/// round two gets the call's output and answers. One backend call per round.
#[test]
fn a_tool_loop_runs_round_by_round_through_the_backend() {
    for p in ["openai", "gemini"] {
        let first = if p == "openai" {
            json!({"output": [{"type": "function_call", "call_id": "call_1", "name": "get_document", "arguments": "{}"}]})
        } else {
            json!({"candidates": [{"content": {"role": "model", "parts": [{"functionCall": {"name": "get_document", "args": {}}, "thoughtSignature": "U0lH"}]}}]})
        };
        let done = if p == "openai" { openai_text("It is 400 × 300.") } else { gemini_text("It is 400 × 300.") };
        let server = MockServer::replies(vec![Reply::ok(first), Reply::ok(done)]);
        let b = backend(accounts(&server), Caller::Person);
        let mut req = ChatRequest {
            choice: Choice { provider: photocraft_engine::generative::ProviderId::parse(p), model: None },
            instructions: "You edit images.".into(),
            messages: vec![ChatMessage::User { text: "How big is it?".into(), images: vec![] }],
            tools: tools(),
        };
        let turn: ChatTurn = b.chat(&req, &|| false).unwrap();
        assert_eq!(turn.tool_calls.len(), 1, "{p}");
        let call = turn.tool_calls[0].clone();
        req.messages.push(ChatMessage::Turn(turn));
        req.messages.push(ChatMessage::ToolResults(vec![ToolResult { call_id: call.id, name: call.name, output: json!({"width": 400, "height": 300}) }]));
        let answer = b.chat(&req, &|| false).unwrap();
        assert_eq!(answer.text, "It is 400 × 300.");
        assert!(answer.tool_calls.is_empty());
        let got = server.requests();
        assert_eq!(got.len(), 2, "{p}: one request per round, models chosen in AI Accounts");
        let second = got[1].json().to_string();
        if p == "openai" {
            assert!(second.contains("function_call_output") && second.contains("call_1"), "{second}");
        } else {
            assert!(second.contains("functionResponse") && second.contains("U0lH"), "{second}");
        }
    }
}
