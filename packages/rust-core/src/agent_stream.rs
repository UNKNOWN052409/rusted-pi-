/// Streaming support for agent LLM calls — SSE parsing
///
/// Parses Server-Sent Events (SSE) from OpenAI-compatible streaming endpoints.
/// Each event is a JSON line prefixed with "data: ".

use std::time::Duration;

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

    let response = call_llm_stream_with_retry(&agent, state, &body)?;

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

    // Stream line-by-line and emit deltas immediately so clients see progress.
    // A read timeout mid-stream is surfaced as an error; the agent loop fails
    // that turn, but the already-emitted deltas are not lost (client sees them).
    {
        use std::io::{BufRead, BufReader};
        let mut reader = BufReader::new(response.into_reader());
        let mut line_buf = Vec::new();
        let mut first_line_opt: Option<Vec<u8>> = None;
        let mut saw_data = false;
        loop {
            line_buf.clear();
            let read = reader
                .read_until(b'\n', &mut line_buf)
                .map_err(|e| format!("Failed to read LLM streaming body: {}", e))?;
            if read == 0 {
                break;
            }
            let raw_line = String::from_utf8_lossy(&line_buf);
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            if first_line_opt.is_none() {
                first_line_opt = Some(line_buf.clone());
            }

            // SSE data line (tolerate 'data: ' and 'data:' variants)
            if let Some(data) = line.strip_prefix("data: ").or_else(|| line.strip_prefix("data:")) {
                saw_data = true;
                let handle_line = process_sse_line(
                    data,
                    &mut full_content,
                    &mut tool_calls_map,
                    &mut on_event,
                );
                if handle_line == ProcessLine::Done {
                    break;
                }
            }
        }

        // Some proxies ignore `stream: true` and return a plain JSON body.
        // Detect that (first line is JSON object, no `data:` prefix seen) and
        // emit it as a single complete event so the client still gets content.
        if !saw_data {
            if let Some(first_bytes) = first_line_opt {
                let first = String::from_utf8_lossy(&first_bytes);
                let trimmed = first.trim_start();
                if trimmed.starts_with('{') {
                    if let Ok(llm_response) = parse_plain_json_response(&trimmed) {
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

                        if !content.is_empty() {
                            let evt = StreamEvent {
                                content_delta: content.clone(),
                                is_done: false,
                                finish_reason: None,
                                tool_calls: Vec::new(),
                            };
                            on_event(&evt);
                        }
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
                        full_content.push_str(&content);
                    }
                }
            }
        }
    }

    Ok(full_content)
}

/// Parse a plain (non-SSE) LlmResponse from the start of a JSON body.
/// Uses a streaming deserializer so a trailing `data: [DONE]` or newline
/// appended by a proxy does not cause a parse failure.
fn parse_plain_json_response(body: &str) -> Result<LlmResponse, serde_json::Error> {
    use serde::Deserialize;
    use serde_json::de::Deserializer;
    let mut de = Deserializer::from_str(body);
    let val = LlmResponse::deserialize(&mut de)?;
    let _ = de.end();
    Ok(val)
}

/// Outcome of processing a single SSE data line.
#[derive(PartialEq, Eq)]
enum ProcessLine {
    /// Continue reading the stream.
    Continue,
    /// Received `[DONE]`; stop reading.
    Done,
}

/// Parse one SSE `data:` payload (without the `data:` prefix), emit deltas via
/// `on_event`, and report whether the stream is finished. Shared by line-based
/// and buffered parsing so both paths behave identically.
fn process_sse_line<F: FnMut(&StreamEvent)>(
    data: &str,
    full_content: &mut String,
    tool_calls_map: &mut std::collections::HashMap<usize, StreamToolCall>,
    on_event: &mut F,
) -> ProcessLine {
    if data.trim() == "[DONE]" {
        let event = StreamEvent {
            content_delta: String::new(),
            is_done: true,
            finish_reason: Some("stop".to_string()),
            tool_calls: Vec::new(),
        };
        on_event(&event);
        return ProcessLine::Done;
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
            ProcessLine::Continue
        }
        Err(e) => {
            // Non-JSON lines may appear (e.g. keepalive comments)
            if !data.trim_start().starts_with(':') {
                eprintln!("SSE parse warning: {} for line: {}", e, &data[..data.floor_char_boundary(data.len().min(200))]);
            }
            ProcessLine::Continue
        }
    }
}

/// Send the streaming request, retrying transient failures (connection errors,
/// DNS, IO, 408/429/5xx) with capped exponential backoff. Matches the retry
/// behavior of the Node agent (`packages/ai/src/utils/retry.ts`).
fn call_llm_stream_with_retry(
    agent: &ureq::Agent,
    state: &AgentState,
    body: &str,
) -> Result<ureq::Response, String> {
    let max_retries = 3;
    let mut attempt = 0;
    loop {
        let result = agent
            .post(&state.config.endpoint)
            .set("Content-Type", "application/json")
            .set("Authorization", &format!("Bearer {}", state.config.api_key))
            .set("Accept", "text/event-stream")
            .send_string(body);

        match result {
            Ok(response) => {
                let status = response.status();
                if is_retryable_status(status) && attempt < max_retries {
                    attempt += 1;
                    eprintln!("LLM streaming request got {} (attempt {}), retrying", status, attempt);
                    std::thread::sleep(retry_delay(attempt));
                    continue;
                }
                return Ok(response);
            }
            Err(ureq::Error::Status(status, response)) => {
                if is_retryable_status(status) && attempt < max_retries {
                    attempt += 1;
                    eprintln!("LLM streaming request got {} (attempt {}), retrying", status, attempt);
                    std::thread::sleep(retry_delay(attempt));
                    continue;
                }
                let body_text = response.into_string().unwrap_or_default();
                return Err(format!("LLM API returned {}: {}", status, body_text));
            }
            Err(ureq::Error::Transport(transport)) => {
                if is_retryable_transport(&transport) && attempt < max_retries {
                    attempt += 1;
                    eprintln!("LLM streaming request transport error (attempt {}): {}", attempt, transport);
                    std::thread::sleep(retry_delay(attempt));
                    continue;
                }
                return Err(format!("LLM streaming request failed: {}", transport));
            }
        }
    }
}

fn is_retryable_status(status: u16) -> bool {
    status == 408 || status == 429 || (status >= 500 && status != 501 && status != 505)
}

fn is_retryable_transport(transport: &ureq::Transport) -> bool {
    use ureq::ErrorKind;
    match transport.kind() {
        ErrorKind::Dns | ErrorKind::ConnectionFailed | ErrorKind::Io | ErrorKind::ProxyConnect => true,
        _ => false,
    }
}

/// Exponential backoff matching the Node agent: 1s, 2s, 4s (max 3 retries).
fn retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(1000u64.saturating_mul(1 << (attempt.saturating_sub(1))))
}
