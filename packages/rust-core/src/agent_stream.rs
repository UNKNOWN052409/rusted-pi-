/// Streaming support for agent LLM calls — SSE parsing
///
/// Parses Server-Sent Events (SSE) from OpenAI-compatible streaming endpoints.
/// Each event is a JSON line prefixed with "data: ".

use crate::agent_types::*;

/// A single streaming delta from the LLM
#[derive(Debug)]
pub struct StreamEvent {
    pub content_delta: String,
    pub is_done: bool,
    pub finish_reason: Option<String>,
    pub tool_calls: Vec<StreamToolCall>,
}

#[derive(Debug, Clone)]
pub struct StreamToolCall {
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: String, // accumulated JSON string
}

/// Call LLM with streaming, calling a callback for each event
pub fn call_llm_stream<F: FnMut(&StreamEvent)>(
    state: &AgentState,
    tools: &[ToolDefinition],
    mut on_event: F,
) -> Result<String, String> {
    let messages = state.to_llm_messages();

    let request = LlmRequest {
        model: state.config.model.clone(),
        messages,
        max_tokens: state.config.max_tokens,
        stream: true, // Enable streaming
        tools: Some(tools.to_vec()),
    };

    let body = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to serialize request: {}", e))?;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(30))
        .timeout_read(std::time::Duration::from_secs(300)) // longer timeout for streaming
        .build();

    let response = agent
        .post(&state.config.endpoint)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {}", state.config.api_key))
        .set("Accept", "text/event-stream")
        .send_string(&body)
        .map_err(|e| format!("LLM streaming request failed: {}", e))?;

    let status = response.status();
    if status != 200 {
        let body_text = response.into_string().unwrap_or_default();
        return Err(format!("LLM API returned {}: {}", status, body_text));
    }

    // DEBUG: dump response headers BEFORE consuming the body
    if std::env::var("STREAM_DEBUG").is_ok() {
        eprintln!("[STREAM_DEBUG] status={}", status);
        eprintln!("[STREAM_DEBUG] content-type={:?}", response.header("Content-Type"));
    }

    let mut full_content = String::new();
    let mut tool_calls_map: std::collections::HashMap<usize, StreamToolCall> = std::collections::HashMap::new();

    // Read the ENTIRE body into a string first (streaming may be buffered by proxy)
    let mut body = String::new();
    {
        use std::io::Read;
        let mut reader = response.into_reader();
        reader.read_to_string(&mut body)
            .map_err(|e| format!("Failed to read LLM streaming body: {}", e))?;
    }

    // DEBUG: dump raw response body shape
    if std::env::var("STREAM_DEBUG").is_ok() {
        eprintln!("[STREAM_DEBUG] body len={} first 800 chars:", body.len());
        eprintln!("{}", &body[..body.floor_char_boundary(body.len().min(800))]);
    }

    // If the body is plain JSON (not SSE), parse as a normal LlmResponse and emit ONE event.
    // NOTE: the proxy may append "data: [DONE]" directly after the JSON without a newline,
    // so use serde_json::Deserializer (parses first value, ignores trailing content).
    let trimmed = body.trim_start();
    if trimmed.starts_with('{') && !trimmed.starts_with("data:") {
        if std::env::var("STREAM_DEBUG").is_ok() {
            eprintln!("[STREAM_DEBUG] body is plain JSON — emitting single event");
        }
        let llm_response: LlmResponse = {
            use serde_json::de::Deserializer;
            use serde::Deserialize;
            let mut de = Deserializer::from_str(&body);
            let val = LlmResponse::deserialize(&mut de)
                .map_err(|e| format!("Failed to parse non-streaming LLM response: {} -- body: {}", e, &body[..body.floor_char_boundary(body.len().min(500))]))?;
            // consume trailing tokens (e.g. "data: [DONE]") so we don't error on them
            let _ = de.end();
            val
        };

        let content = llm_response.choices.first()
            .and_then(|c| c.message.content.as_deref())
            .unwrap_or("")
            .to_string();
        let tool_calls = llm_response.choices.first()
            .and_then(|c| c.message.tool_calls.clone())
            .unwrap_or_default();
        let finish_reason = llm_response.choices.first()
            .and_then(|c| c.finish_reason.as_deref())
            .unwrap_or("stop")
            .to_string();

        // Emit the full content as a delta (is_done=false so clients see type "delta")
        if !content.is_empty() {
            let evt = StreamEvent {
                content_delta: content.clone(),
                is_done: false,
                finish_reason: None,
                tool_calls: Vec::new(),
            };
            on_event(&evt);
        }

        // Emit tool calls (if any) as separate events
        for tc in &tool_calls {
            let evt = StreamEvent {
                content_delta: String::new(),
                is_done: false,
                finish_reason: None,
                tool_calls: vec![StreamToolCall {
                    index: 0,
                    id: Some(tc.id.clone()),
                    name: Some(tc.function.name.clone()),
                    arguments: tc.function.arguments.clone(),
                }],
            };
            on_event(&evt);
        }

        let done_evt = StreamEvent {
            content_delta: String::new(),
            is_done: true,
            finish_reason: Some(finish_reason),
            tool_calls: Vec::new(),
        };
        on_event(&done_evt);

        return Ok(content);
    }

    // Parse SSE lines from the already-read body string
    for raw_line in body.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        // SSE data line (tolerate 'data: ' and 'data:' variants)
        if let Some(data) = line.strip_prefix("data: ").or_else(|| line.strip_prefix("data:")) {
            if data.trim() == "[DONE]" {
                let event = StreamEvent {
                    content_delta: String::new(),
                    is_done: true,
                    finish_reason: Some("stop".to_string()),
                    tool_calls: Vec::new(),
                };
                on_event(&event);
                break;
            }

            match serde_json::from_str::<serde_json::Value>(data) {
                Ok(json) => {
                    // OpenAI streaming format:
                    // choices[0].delta.content
                    // choices[0].delta.tool_calls
                    // choices[0].finish_reason
                    if let Some(choices) = json.get("choices").and_then(|c| c.as_array()) {
                        if let Some(choice) = choices.first() {
                            let delta = choice.get("delta");

                            // Text content
                            let content_delta = delta
                                .and_then(|d| d.get("content"))
                                .and_then(|c| c.as_str())
                                .unwrap_or("")
                                .to_string();
                            full_content.push_str(&content_delta);

                            // Tool calls (streaming — accumulated)
                            let mut stream_tool_calls = Vec::new();
                            if let Some(tcs) = delta.and_then(|d| d.get("tool_calls")).and_then(|t| t.as_array()) {
                                for tc in tcs {
                                    let index = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                                    let id = tc.get("id").and_then(|i| i.as_str()).map(|s| s.to_string());
                                    let name = tc.get("function")
                                        .and_then(|f| f.get("name"))
                                        .and_then(|n| n.as_str())
                                        .map(|s| s.to_string());
                                    let args = tc.get("function")
                                        .and_then(|f| f.get("arguments"))
                                        .and_then(|a| a.as_str())
                                        .unwrap_or("")
                                        .to_string();

                                    let entry = tool_calls_map.entry(index).or_insert(StreamToolCall {
                                        index,
                                        id: None,
                                        name: None,
                                        arguments: String::new(),
                                    });

                                    if let Some(i) = id { entry.id = Some(i); }
                                    if let Some(n) = name { entry.name = Some(n); }
                                    entry.arguments.push_str(&args);

                                    stream_tool_calls.push(entry.clone());
                                }
                            }

                            let finish_reason = choice
                                .get("finish_reason")
                                .and_then(|f| f.as_str())
                                .map(|s| s.to_string());

                            let event = StreamEvent {
                                content_delta,
                                is_done: finish_reason.is_some(),
                                finish_reason,
                                tool_calls: stream_tool_calls,
                            };
                            on_event(&event);
                        }
                    }
                }
                Err(e) => {
                    // Non-JSON lines may appear (e.g. keepalive comments)
                    if !line.starts_with(':') {
                        eprintln!("SSE parse warning: {} for line: {}", e, &line[..line.floor_char_boundary(line.len().min(200))]);
                    }
                }
            }
        }
    }

    Ok(full_content)
}
