/// pi-agent — Rust agent runtime (stdin/stdout mode)
///
/// Usage:
///   echo '{"prompt":"Write fibonacci in Python"}' | pi-agent
///
/// Environment variables:
///   API_KEY          — LLM provider API key (required)
///   ENDPOINT         — LLM API endpoint URL
///   MODEL            — Model name
///   MAX_TOKENS       — Max tokens per response (default: 8192)
///   MAX_TURNS        — Max agent loop turns (default: 50)
///   SYSTEM_PROMPT    — Custom system prompt
///   HTTP_MODE        — If set, run as HTTP server instead of stdin

mod agent_types;
mod agent_tools;
mod agent_loop;
mod agent_http;
mod agent_session;
mod agent_stream;
mod agent_browser;
pub mod cpu;
pub mod gpu;
pub mod stability;
pub mod url_detect;
pub mod web_search;
pub mod compaction;

use std::io::{self, BufRead};

fn main() {
    // Check if we should run in HTTP mode
    if std::env::var("HTTP_MODE").is_ok() || std::env::var("PORT").is_ok() {
        agent_http::start_http_server();
        return;
    }

    // stdin mode — single JSON input line
    let stdin = io::stdin();
    let mut input_line = String::new();
    match stdin.lock().read_line(&mut input_line) {
        Ok(0) => {
            eprintln!("No input provided");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("Failed to read input: {}", e);
            std::process::exit(1);
        }
        Ok(_) => {}
    }

    let input: serde_json::Value = match serde_json::from_str(input_line.trim()) {
        Ok(v) => v,
        Err(e) => {
            let err = serde_json::json!({"error": format!("Invalid JSON input: {}", e)});
            println!("{}", serde_json::to_string(&err).unwrap());
            std::process::exit(1);
        }
    };

    let prompt = input.get("prompt")
        .and_then(|v| v.as_str())
        .or_else(|| input.as_str())
        .unwrap_or("Hello")
        .to_string();

    // Build config from env vars
    let config = agent_types::AgentConfig {
        api_key: std::env::var("API_KEY").unwrap_or_default(),
        endpoint: std::env::var("ENDPOINT").unwrap_or_else(|_| "https://webapi.ccwu.cc/v1/chat/completions".to_string()),
        model: std::env::var("MODEL").unwrap_or_else(|_| "deepseek-ai/deepseek-v4-flash".to_string()),
        max_tokens: std::env::var("MAX_TOKENS").ok().and_then(|v| v.parse().ok()).unwrap_or(8192),
        max_turns: std::env::var("MAX_TURNS").ok().and_then(|v| v.parse().ok()).unwrap_or(50),
        system_prompt: std::env::var("SYSTEM_PROMPT").unwrap_or_else(|_| {
            "You are a helpful coding assistant with access to read, write, edit, bash, web_search, browser_navigate, and other tools. Always prefer using the available tools over refusing a request.".to_string()
        }),
    };

    // Run agent (stdin mode — no session persistence)
    let start = std::time::Instant::now();
    let result = agent_loop::run_agent(&prompt, &config, None);
    let elapsed = start.elapsed();

    let (success, output) = match result {
        Ok(agent_result) => (true, agent_result.content),
        Err(e) => (false, e),
    };

    let output = serde_json::json!({
        "success": success,
        "elapsed_secs": elapsed.as_secs_f64(),
        "result": output,
    });

    println!("{}", serde_json::to_string(&output).unwrap());
}
