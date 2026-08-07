/// pi-agent HTTP server with sessions and streaming
///
/// Listens on PORT env var (Render sets this).
/// Routes:
///   GET  /health       — health check
///   POST /agent        — non-streaming agent (with optional session_id)
///   POST /agent/stream — streaming agent (SSE response)
///   GET  /sessions     — list active sessions

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

const BUF_SIZE: usize = 1024 * 1024; // 1MB max body

pub fn start_http_server() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let listener = TcpListener::bind(&addr)
        .unwrap_or_else(|e| {
            eprintln!("Failed to bind to {}: {}", addr, e);
            std::process::exit(1);
        });

    eprintln!("pi-agent HTTP server listening on {}", addr);

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                thread::spawn(|| {
                    handle_connection(stream);
                });
            }
            Err(e) => {
                eprintln!("Connection error: {}", e);
            }
        }
    }
}

fn handle_connection(mut stream: TcpStream) {
    stream.set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap_or(());

    let mut buf = vec![0u8; BUF_SIZE];
    let n = match stream.read(&mut buf) {
        Ok(0) => return,
        Ok(n) => n,
        Err(_) => return,
    };

    let request = String::from_utf8_lossy(&buf[..n]);

    let (method, path, body) = match parse_http_request(&request) {
        Some(m) => m,
        None => {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
            return;
        }
    };

    match (method, path) {
        ("GET", "/health") => handle_health(stream),
        ("POST", "/agent") => handle_agent(stream, body, false),
        ("POST", "/agent/stream") => handle_agent(stream, body, true),
        ("GET", "/sessions") => handle_list_sessions(stream),
        ("POST", "/") => handle_agent(stream, body, false),
        _ => {
            let resp = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(resp);
        }
    }
}

fn parse_http_request(request: &str) -> Option<(&str, &str, &str)> {
    let mut lines = request.lines();
    let first_line = lines.next()?;
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let method = parts[0];
    let path = parts[1];

    let body_start = request.find("\r\n\r\n")?;
    let body = &request[body_start + 4..];
    let body = body.trim_end_matches('\0').trim();

    Some((method, path, body))
}

fn handle_health(mut stream: TcpStream) {
    let body = r#"{"status":"ok","service":"pi-agent-rust","version":"0.2.0"}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(), body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn handle_list_sessions(mut stream: TcpStream) {
    let sessions = crate::agent_session::list_sessions().unwrap_or_default();
    let body = serde_json::json!({
        "sessions": sessions,
        "count": sessions.len()
    }).to_string();

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}",
        body.len(), body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn handle_agent(mut stream: TcpStream, body: &str, use_streaming: bool) {
    let input: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            let error = serde_json::json!({"error": format!("Invalid JSON: {}", e)});
            let body = serde_json::to_string(&error).unwrap();
            let response = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(), body
            );
            let _ = stream.write_all(response.as_bytes());
            return;
        }
    };

    let prompt = input.get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("Hello")
        .to_string();

    // Session support
    let session_id = input.get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| crate::agent_session::generate_session_id());

    let existing_messages = crate::agent_session::load_session(&session_id).ok();

    // Build config from env vars
    let config = crate::agent_types::AgentConfig {
        api_key: std::env::var("API_KEY").unwrap_or_default(),
        endpoint: std::env::var("ENDPOINT").unwrap_or_else(|_| "https://webapi.ccwu.cc/v1/chat/completions".to_string()),
        model: std::env::var("MODEL").unwrap_or_else(|_| "deepseek-ai/deepseek-v4-flash".to_string()),
        max_tokens: std::env::var("MAX_TOKENS").ok().and_then(|v| v.parse().ok()).unwrap_or(8192),
        max_turns: std::env::var("MAX_TURNS").ok().and_then(|v| v.parse().ok()).unwrap_or(50),
        system_prompt: std::env::var("SYSTEM_PROMPT").unwrap_or_else(|_| {
            "You are a helpful coding assistant with access to read, write, edit, bash, web_search, browser_navigate, and other tools. Always prefer using the available tools over refusing a request.".to_string()
        }),
    };

    if use_streaming {
        handle_agent_streaming(stream, &prompt, &session_id, existing_messages, &config);
    } else {
        handle_agent_non_streaming(stream, &prompt, &session_id, existing_messages, &config);
    }
}

fn handle_agent_non_streaming(
    mut stream: TcpStream,
    prompt: &str,
    session_id: &str,
    existing_messages: Option<Vec<crate::agent_types::Message>>,
    config: &crate::agent_types::AgentConfig,
) {
    let start = std::time::Instant::now();

    let result = crate::agent_loop::run_agent(prompt, config, existing_messages);

    let elapsed = start.elapsed();
    let (success, output, messages) = match result {
        Ok(agent_result) => (true, agent_result.content, agent_result.messages),
        Err(e) => (false, e, Vec::new()),
    };

    // Save session
    let _ = crate::agent_session::save_session(session_id, &messages);

    let output = serde_json::json!({
        "success": success,
        "elapsed_secs": elapsed.as_secs_f64(),
        "session_id": session_id,
        "result": output,
    });

    let body = serde_json::to_string(&output).unwrap_or_else(|_| "{\"success\":false,\"error\":\"serialization failed\"}".to_string());
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}",
        body.len(), body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn handle_agent_streaming(
    mut stream: TcpStream,
    prompt: &str,
    session_id: &str,
    existing_messages: Option<Vec<crate::agent_types::Message>>,
    config: &crate::agent_types::AgentConfig,
) {
    // SSE response header
    let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.flush();

    // Use streaming agent loop
    let result = crate::agent_loop::run_agent_streaming(
        prompt,
        config,
        existing_messages,
        |event: &crate::agent_stream::StreamEvent| {
            let sse = serde_json::json!({
                "type": if event.is_done { "done" } else { "delta" },
                "content": event.content_delta,
                "finish_reason": event.finish_reason,
            });

            let sse_line = format!("data: {}\n\n", serde_json::to_string(&sse).unwrap_or_default());
            let _ = stream.write_all(sse_line.as_bytes());
            let _ = stream.flush();
        },
    );

    match result {
        Ok((_content, messages)) => {
            let _ = crate::agent_session::save_session(session_id, &messages);

            // Send final done event with session_id
            let done = serde_json::json!({
                "type": "session_end",
                "session_id": session_id,
                "message_count": messages.len(),
            });
            let done_line = format!("data: {}\n\n", serde_json::to_string(&done).unwrap_or_default());
            let _ = stream.write_all(done_line.as_bytes());
            let _ = stream.flush();
        }
        Err(e) => {
            let error = serde_json::json!({
                "type": "error",
                "error": e,
            });
            let err_line = format!("data: {}\n\n", serde_json::to_string(&error).unwrap_or_default());
            let _ = stream.write_all(err_line.as_bytes());
            let _ = stream.flush();
        }
    }
}
