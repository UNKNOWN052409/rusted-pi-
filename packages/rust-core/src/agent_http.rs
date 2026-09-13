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
const HEADER_END: &[u8] = b"\r\n\r\n";

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
    stream.set_read_timeout(Some(Duration::from_secs(120)))
        .unwrap_or(());

    // Read the full HTTP request: headers first, then body by Content-Length.
    let mut buf = Vec::with_capacity(8192);
    let header_end = loop {
        let mut chunk = [0u8; 8192];
        let n = match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => n,
            Err(_) => return,
        };
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_subslice(&buf, HEADER_END) {
            break pos;
        }
        if buf.len() > BUF_SIZE {
            let _ = stream.write_all(b"HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n");
            return;
        }
    };

    let content_length: usize = parse_content_length(&String::from_utf8_lossy(&buf[..header_end]))
        .unwrap_or(0)
        .min(BUF_SIZE);

    // Read the body in a loop until we have all Content-Length bytes.
    while buf.len() < header_end + 4 + content_length {
        let mut chunk = [0u8; 8192];
        let n = match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return,
        };
        buf.extend_from_slice(&chunk[..n]);
    }

    let body_start = header_end + 4;
    let header = String::from_utf8_lossy(&buf[..header_end]);
    let body = String::from_utf8_lossy(&buf[body_start..body_start + content_length.min(buf.len() - body_start)]);

    let (method, path) = match parse_request_line(&header) {
        Some(m) => m,
        None => {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
            return;
        }
    };

    match (method, path) {
        ("GET", "/health") => handle_health(stream),
        ("POST", "/agent") => handle_agent(stream, &body, false),
        ("POST", "/agent/stream") => handle_agent(stream, &body, true),
        ("GET", "/sessions") => handle_list_sessions(stream),
        ("POST", "/") => handle_agent(stream, &body, false),
        _ => {
            let resp = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(resp);
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_request_line(header: &str) -> Option<(&str, &str)> {
    let first_line = header.lines().next()?;
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    Some((parts[0], parts[1]))
}

fn parse_content_length(header: &str) -> Option<usize> {
    for line in header.lines() {
        if let Some(value) = line.split_once(':') {
            if value.0.trim().eq_ignore_ascii_case("content-length") {
                return value.1.trim().parse().ok();
            }
        }
    }
    None
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
    let api_key = std::env::var("API_KEY").unwrap_or_default();
    let endpoint = std::env::var("ENDPOINT").unwrap_or_else(|_| "https://api.openai.com/v1/chat/completions".to_string());
    let model = std::env::var("MODEL").unwrap_or_else(|_| "gpt-4-turbo".to_string());
    
    // Validate API key is set
    if api_key.is_empty() {
        let error = serde_json::json!({
            "error": "API_KEY environment variable not set. Configure LLM credentials to use the agent.",
            "hint": "Set API_KEY, MODEL, and ENDPOINT environment variables"
        });
        let body = serde_json::to_string(&error).unwrap();
        let response = format!(
            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(), body
        );
        let _ = stream.write_all(response.as_bytes());
        return;
    }
    
    let config = crate::agent_types::AgentConfig {
        api_key,
        endpoint,
        model,
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

    // Render and other reverse proxies drop connections with no data after
    // roughly 60s. Tool calls can run longer than that without emitting a
    // delta, so send a comment keep-alive on a cloned socket every 15s.
    let keepalive_stream = match stream.try_clone() {
        Ok(s) => Some(s),
        Err(_) => None,
    };
    let keepalive_stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag = keepalive_stop.clone();
    if let Some(mut ka) = keepalive_stream {
        thread::spawn(move || {
            while !stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
                thread::sleep(Duration::from_secs(15));
                if stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                let _ = ka.write_all(b": keepalive\n\n");
                let _ = ka.flush();
            }
        });
    }

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

    keepalive_stop.store(true, std::sync::atomic::Ordering::Relaxed);

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
