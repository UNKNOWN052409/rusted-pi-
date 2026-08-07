/// Agent shared types — message types, tool call/result structs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Message Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum Message {
    #[serde(rename = "system")]
    System { content: String },
    #[serde(rename = "user")]
    User { content: Vec<ContentBlock> },
    #[serde(rename = "assistant")]
    Assistant {
        content: Vec<ContentBlock>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
    },
    #[serde(rename = "toolResult")]
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        content: Vec<ContentBlock>,
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "toolCall")]
    ToolCall {
        id: String,
        name: String,
        arguments: HashMap<String, serde_json::Value>,
    },
    #[serde(rename = "toolResult")]
    ToolResult { id: String, name: String, result: serde_json::Value },
}

// ── LLM Request/Response ──

#[derive(Debug, Serialize)]
pub struct LlmRequest {
    pub model: String,
    pub messages: Vec<LlmMessage>,
    pub max_tokens: u32,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub type_field: String,
    pub function: ToolFunction,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct LlmResponse {
    pub choices: Vec<LlmChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
pub struct LlmChoice {
    pub message: LlmResponseMessage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LlmResponseMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<LlmToolCall>>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LlmToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub type_field: String,
    pub function: LlmToolFunction,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LlmToolFunction {
    pub name: String,
    pub arguments: String, // raw JSON string
}

#[derive(Debug, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

// ── Agent Config ──

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub api_key: String,
    pub endpoint: String,
    pub model: String,
    pub max_tokens: u32,
    pub max_turns: u32,
    pub system_prompt: String,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            endpoint: "https://webapi.ccwu.cc/v1/chat/completions".to_string(),
            model: "deepseek-ai/deepseek-v4-flash".to_string(),
            max_tokens: 8192,
            max_turns: 50,
            system_prompt: "You are a helpful coding assistant with access to read, write, edit, bash, web_search, browser_navigate, and other tools. Always prefer using the available tools over refusing a request.".to_string(),
        }
    }
}

// ── Agent State ──

#[derive(Debug)]
pub struct AgentState {
    pub messages: Vec<Message>,
    pub config: AgentConfig,
    pub turn_count: u32,
}

impl AgentState {
    pub fn new(config: AgentConfig) -> Self {
        Self {
            messages: Vec::new(),
            config,
            turn_count: 0,
        }
    }

    /// Convert Agent messages to LLM API format
    pub fn to_llm_messages(&self) -> Vec<LlmMessage> {
        let mut llm_msgs = Vec::new();

        // System prompt
        llm_msgs.push(LlmMessage {
            role: "system".to_string(),
            content: self.config.system_prompt.clone(),
            tool_call_id: None,
        });

        for msg in &self.messages {
            match msg {
                Message::User { content } => {
                    let text: Vec<String> = content.iter()
                        .filter_map(|c| match c {
                            ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect();
                    llm_msgs.push(LlmMessage {
                        role: "user".to_string(),
                        content: text.join("\n"),
                        tool_call_id: None,
                    });
                }
                Message::Assistant { content, .. } => {
                    let text: Vec<String> = content.iter()
                        .filter_map(|c| match c {
                            ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect();
                    llm_msgs.push(LlmMessage {
                        role: "assistant".to_string(),
                        content: text.join("\n"),
                        tool_call_id: None,
                    });
                }
                Message::ToolResult { tool_call_id, tool_name: _, content, is_error: _ } => {
                    let text: Vec<String> = content.iter()
                        .filter_map(|c| match c {
                            ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect();
                    llm_msgs.push(LlmMessage {
                        role: "tool".to_string(),
                        content: text.join("\n"),
                        tool_call_id: Some(tool_call_id.clone()),
                    });
                }
                Message::System { content } => {
                    // Skip — already added at top
                    llm_msgs.push(LlmMessage {
                        role: "system".to_string(),
                        content: content.clone(),
                        tool_call_id: None,
                    });
                }
            }
        }

        llm_msgs
    }
}
