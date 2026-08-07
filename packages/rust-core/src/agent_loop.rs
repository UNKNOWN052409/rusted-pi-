/// Agent loop module — shared by agent_bin (stdin) and agent_http (HTTP server)
///
/// Supports both stateless and session-based multi-turn conversations.
/// Supports both streaming and non-streaming LLM calls.

use std::collections::HashMap;

use crate::agent_types::*;
use crate::agent_tools;
use crate::agent_stream::StreamEvent;

/// Result of running the agent loop
#[derive(Debug, Clone)]
pub struct AgentResult {
    pub content: String,
    pub messages: Vec<Message>,
}

/// Run the agent loop with session support (non-streaming)
/// If existing_messages is provided, continues from that conversation.
pub fn run_agent(
    prompt: &str,
    config: &AgentConfig,
    existing_messages: Option<Vec<Message>>,
) -> Result<AgentResult, String> {
    let mut state = if let Some(mut msgs) = existing_messages {
        let mut s = AgentState::new(config.clone());
        s.messages.append(&mut msgs);
        s
    } else {
        AgentState::new(config.clone())
    };

    // Add user message
    state.messages.push(Message::User {
        content: vec![ContentBlock::Text { text: prompt.to_string() }],
    });

    let tools = agent_tools::builtin_tools();

    // Agent loop
    for turn in 0..config.max_turns {
        state.turn_count = turn + 1;

        // Call LLM
        let response = call_llm(&state, &tools)?;

        let content = response.choices.first()
            .and_then(|c| c.message.content.as_deref())
            .unwrap_or("")
            .to_string();

        let tool_calls = response.choices.first()
            .and_then(|c| c.message.tool_calls.clone())
            .unwrap_or_default();

        // Build assistant message content
        let mut msg_content = vec![ContentBlock::Text { text: content.clone() }];
        for tc in &tool_calls {
            let args: HashMap<String, serde_json::Value> = serde_json::from_str(&tc.function.arguments)
                .unwrap_or_default();
            msg_content.push(ContentBlock::ToolCall {
                id: tc.id.clone(),
                name: tc.function.name.clone(),
                arguments: args,
            });
        }

        let finish_reason = response.choices.first()
            .and_then(|c| c.finish_reason.as_deref())
            .unwrap_or("stop")
            .to_string();

        state.messages.push(Message::Assistant {
            content: msg_content,
            stop_reason: Some(finish_reason.clone()),
        });

        // No tool calls → done
        if tool_calls.is_empty() || finish_reason == "stop" {
            return Ok(AgentResult {
                content,
                messages: state.messages,
            });
        }

        // Execute tool calls
        for tc in &tool_calls {
            let args: HashMap<String, serde_json::Value> = serde_json::from_str(&tc.function.arguments)
                .unwrap_or_default();

            let tool_result = agent_tools::execute_tool(&tc.function.name, &args);
            let is_error = tool_result.is_err();
            let result_content = match tool_result {
                Ok(blocks) => blocks,
                Err(e) => vec![ContentBlock::Text { text: e }],
            };

            state.messages.push(Message::ToolResult {
                tool_call_id: tc.id.clone(),
                tool_name: tc.function.name.clone(),
                content: result_content,
                is_error,
            });
        }

        if turn + 1 >= config.max_turns {
            return Ok(AgentResult {
                content: format!("{}{}", content, "\n\n[Max turns reached]"),
                messages: state.messages,
            });
        }
    }

    Err("Max turns reached without completion".to_string())
}

/// Run the agent loop with streaming support
/// Calls on_event for each streaming delta, accumulates messages for session persistence
pub fn run_agent_streaming<F: FnMut(&StreamEvent)>(
    prompt: &str,
    config: &AgentConfig,
    existing_messages: Option<Vec<Message>>,
    mut on_event: F,
) -> Result<(String, Vec<Message>), String> {
    let mut state = if let Some(mut msgs) = existing_messages {
        let mut s = AgentState::new(config.clone());
        s.messages.append(&mut msgs);
        s
    } else {
        AgentState::new(config.clone())
    };

    // Add user message
    state.messages.push(Message::User {
        content: vec![ContentBlock::Text { text: prompt.to_string() }],
    });

    let tools = agent_tools::builtin_tools();
    let max_turns = config.max_turns.max(1);
    let mut accumulated_content = String::new();

    // Multi-turn agent loop (streaming). Each turn:
    //   1. Stream LLM response (content deltas + tool call deltas)
    //   2. Store assistant message with accumulated content + tool calls
    //   3. If no tool calls or finish_reason == stop → return
    //   4. Execute tools, append tool results, loop back for next turn
    for turn in 0..max_turns {
        state.turn_count = turn + 1;

        // Collect tool calls + finish_reason from the stream events (no second API call needed)
        let mut tc_map: HashMap<usize, LlmToolCall> = HashMap::new();
        let mut last_finish_reason: Option<String> = None;
        let mut inner_on_event = |event: &StreamEvent| {
            on_event(event);
            if let Some(fr) = &event.finish_reason {
                last_finish_reason = Some(fr.clone());
            }
            for tc in &event.tool_calls {
                // Events carry the latest accumulated tool-call state per index,
                // so replace (not append) to avoid double-counting across SSE chunks.
                tc_map.insert(tc.index, LlmToolCall {
                    id: tc.id.clone().unwrap_or_default(),
                    type_field: "function".to_string(),
                    function: LlmToolFunction {
                        name: tc.name.clone().unwrap_or_default(),
                        arguments: tc.arguments.clone(),
                    },
                });
            }
        };

        // Stream the LLM response for this turn
        let streamed_text = crate::agent_stream::call_llm_stream(
            &state,
            &tools,
            &mut inner_on_event,
        )?;

        // Finish reason: prefer the last one seen in stream events, default to stop
        let finish_reason = last_finish_reason.unwrap_or_else(|| "stop".to_string());

        // Tool calls in index order (stable for message construction + execution)
        let mut tool_calls: Vec<LlmToolCall> = tc_map.into_values().collect();
        tool_calls.sort_by_key(|tc| {
            tc.function.name.clone() // stable order fallback; index not preserved in LlmToolCall
        });

        accumulated_content.push_str(&streamed_text);

        // Store assistant message BEFORE tool-call detection (correct state ordering)
        let mut msg_content = vec![ContentBlock::Text { text: streamed_text.clone() }];
        for tc in &tool_calls {
            let args: HashMap<String, serde_json::Value> = serde_json::from_str(&tc.function.arguments)
                .unwrap_or_default();
            msg_content.push(ContentBlock::ToolCall {
                id: tc.id.clone(),
                name: tc.function.name.clone(),
                arguments: args,
            });
        }
        state.messages.push(Message::Assistant {
            content: msg_content,
            stop_reason: Some(finish_reason.clone()),
        });

        // No tool calls → done
        if tool_calls.is_empty() {
            return Ok((streamed_text, state.messages));
        }

        // Execute tool calls
        for tc in &tool_calls {
            let args: HashMap<String, serde_json::Value> = serde_json::from_str(&tc.function.arguments)
                .unwrap_or_default();

            let tool_result = agent_tools::execute_tool(&tc.function.name, &args);
            let is_error = tool_result.is_err();
            let result_content = match tool_result {
                Ok(blocks) => blocks,
                Err(e) => vec![ContentBlock::Text { text: e }],
            };

            state.messages.push(Message::ToolResult {
                tool_call_id: tc.id.clone(),
                tool_name: tc.function.name.clone(),
                content: result_content,
                is_error,
            });
        }

        // Max turns reached → stop after tool execution
        if turn + 1 >= max_turns {
            return Ok((
                format!("{}{}", accumulated_content, "\n\n[Max turns reached]"),
                state.messages,
            ));
        }
    }

    Ok((accumulated_content, state.messages))
}

/// Call the LLM API (non-streaming)
fn call_llm(state: &AgentState, tools: &[ToolDefinition]) -> Result<LlmResponse, String> {
    let messages = state.to_llm_messages();

    let request = LlmRequest {
        model: state.config.model.clone(),
        messages,
        max_tokens: state.config.max_tokens,
        stream: false,
        tools: Some(tools.to_vec()),
    };

    let body = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to serialize request: {}", e))?;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(30))
        .timeout_read(std::time::Duration::from_secs(120))
        .build();

    let response = agent
        .post(&state.config.endpoint)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {}", state.config.api_key))
        .send_string(&body)
        .map_err(|e| format!("LLM API request failed: {}", e))?;

    let status = response.status();
    let response_body = response.into_string()
        .map_err(|e| format!("Failed to read LLM response: {}", e))?;

    if status != 200 {
        return Err(format!("LLM API returned {}: {}", status, response_body));
    }

    let llm_response: LlmResponse = serde_json::from_str(&response_body)
        .map_err(|e| format!("Failed to parse LLM response: {} -- body: {}", e, &response_body[..response_body.floor_char_boundary(response_body.len().min(500))]))?;

    Ok(llm_response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_agent_result_clone() {
        let result = AgentResult {
            content: "hello".to_string(),
            messages: vec![Message::User {
                content: vec![ContentBlock::Text { text: "hi".to_string() }],
            }],
        };
        let cloned = result.clone();
        assert_eq!(cloned.content, "hello");
        assert_eq!(cloned.messages.len(), 1);
    }

    #[test]
    fn test_agent_result_messages_order() {
        // Verify assistant message is stored BEFORE tool results in the loop.
        // Build a minimal state where a tool call message is present.
        let assistant_msg = Message::Assistant {
            content: vec![
                ContentBlock::Text { text: "Let me check.".to_string() },
                ContentBlock::ToolCall {
                    id: "call_1".to_string(),
                    name: "bash".to_string(),
                    arguments: HashMap::from([("command".to_string(), serde_json::json!("echo hi"))]),
                },
            ],
            stop_reason: Some("tool_calls".to_string()),
        };
        let tool_result = Message::ToolResult {
            tool_call_id: "call_1".to_string(),
            tool_name: "bash".to_string(),
            content: vec![ContentBlock::Text { text: "hi".to_string() }],
            is_error: false,
        };

        // Assistant must precede tool result (state ordering invariant)
        let messages = vec![assistant_msg, tool_result];
        let first_is_assistant = matches!(&messages[0], Message::Assistant { .. });
        let second_is_tool = matches!(&messages[1], Message::ToolResult { .. });
        assert!(first_is_assistant, "assistant message must be stored first");
        assert!(second_is_tool, "tool result must follow assistant message");
    }
}
