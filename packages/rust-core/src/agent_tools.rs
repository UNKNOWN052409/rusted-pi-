/// Tool implementations for pi-agent-rust
/// read, write, edit, bash, web_search, fetch_url

use std::collections::HashMap;
use std::process::Command;

use crate::agent_types::{ContentBlock, ToolDefinition, ToolFunction};

// ── Tool Definitions (sent to LLM) ──

pub fn builtin_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            type_field: "function".to_string(),
            function: ToolFunction {
                name: "read".to_string(),
                description: "Read the contents of a file. Supports text files. Output is truncated to 2000 lines or 50KB. Use offset to continue reading.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Path to the file to read"},
                        "offset": {"type": "integer", "description": "Line number to start reading from (1-indexed, default 1)"}
                    },
                    "required": ["path"]
                }),
            },
        },
        ToolDefinition {
            type_field: "function".to_string(),
            function: ToolFunction {
                name: "write".to_string(),
                description: "Write content to a file. Creates parent directories if needed.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Path to the file to write"},
                        "content": {"type": "string", "description": "Content to write"}
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        ToolDefinition {
            type_field: "function".to_string(),
            function: ToolFunction {
                name: "edit".to_string(),
                description: "Edit a file by replacing exact text with new text.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Path to the file to edit"},
                        "old_text": {"type": "string", "description": "Exact text to replace"},
                        "new_text": {"type": "string", "description": "Replacement text"}
                    },
                    "required": ["path", "old_text", "new_text"]
                }),
            },
        },
        ToolDefinition {
            type_field: "function".to_string(),
            function: ToolFunction {
                name: "bash".to_string(),
                description: "Execute a bash command. Returns stdout and stderr.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Bash command to execute"},
                        "timeout": {"type": "number", "description": "Optional timeout in seconds"}
                    },
                    "required": ["command"]
                }),
            },
        },
        ToolDefinition {
            type_field: "function".to_string(),
            function: ToolFunction {
                name: "web_search".to_string(),
                description: "Search the web for a query. Returns top results.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"}
                    },
                    "required": ["query"]
                }),
            },
        },
        ToolDefinition {
            type_field: "function".to_string(),
            function: ToolFunction {
                name: "fetch_url".to_string(),
                description: "Fetch a URL and return its text content.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "URL to fetch"}
                    },
                    "required": ["url"]
                }),
            },
        },
        ToolDefinition {
            type_field: "function".to_string(),
            function: ToolFunction {
                name: "browser_navigate".to_string(),
                description: "Navigate to a URL and return parsed page content. Extracts page title, readable text, links, and raw HTML. For browsing web pages, reading docs, or testing web apps. No JavaScript execution.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "URL to navigate to"},
                        "max_text_length": {"type": "integer", "description": "Max text length to return (default 16000)"}
                    },
                    "required": ["url"]
                }),
            },
        },
        ToolDefinition {
            type_field: "function".to_string(),
            function: ToolFunction {
                name: "browser_screenshot".to_string(),
                description: "Take a screenshot of a page. NOTE: Lightweight mode — returns page description. For actual screenshots, use puppeteer/playwright.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "URL to screenshot"}
                    },
                    "required": []
                }),
            },
        },
        ToolDefinition {
            type_field: "function".to_string(),
            function: ToolFunction {
                name: "browser_evaluate".to_string(),
                description: "Evaluate JavaScript in the browser. NOTE: No JS engine available in lightweight mode. Use puppeteer/playwright for real JS execution.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "code": {"type": "string", "description": "JavaScript code to evaluate"}
                    },
                    "required": ["code"]
                }),
            },
        },
    ]
}

// ── Tool Execution ──

pub fn execute_tool(name: &str, args: &HashMap<String, serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    match name {
        "read" => cmd_read(args),
        "write" => cmd_write(args),
        "edit" => cmd_edit(args),
        "bash" => cmd_bash(args),
        "web_search" => cmd_web_search(args),
        "fetch_url" => cmd_fetch_url(args),
        "browser_navigate" => cmd_browser_navigate(args),
        "browser_screenshot" => cmd_browser_screenshot(args),
        "browser_evaluate" => cmd_browser_evaluate(args),
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

fn get_string_arg(args: &HashMap<String, serde_json::Value>, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Missing or invalid string argument: {}", key))
}

fn cmd_read(args: &HashMap<String, serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    let path = get_string_arg(args, "path")?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path, e))?;

    // Truncate to 50KB
    let lines: Vec<&str> = content.lines().collect();
    let mut output = String::new();
    let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(1).max(1) as usize;

    let mut line_count = 0;
    let mut byte_count = 0;

    for (i, line) in lines.iter().enumerate() {
        if i + 1 < offset {
            continue;
        }
        let line_bytes = line.len() + 1; // +1 for newline
        if line_count >= 2000 || byte_count + line_bytes > 50_000 {
            let remaining = lines.len().saturating_sub(offset - 1 + line_count);
            output.push_str(&format!("\n[Showing {}/{} lines. Use offset={} to continue.]", line_count + (offset - 1), lines.len(), offset + line_count));
            if remaining > 0 {
                output.push_str(&format!(" {} more lines.", remaining));
            }
            break;
        }
        output.push_str(line);
        output.push('\n');
        byte_count += line_bytes;
        line_count += 1;
    }

    Ok(vec![ContentBlock::Text { text: output }])
}

fn cmd_write(args: &HashMap<String, serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    let path = get_string_arg(args, "path")?;
    let content = get_string_arg(args, "content")?;

    // Create parent directories
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories for {}: {}", path, e))?;
    }

    std::fs::write(&path, &content)
        .map_err(|e| format!("Failed to write {}: {}", path, e))?;

    Ok(vec![ContentBlock::Text { text: format!("Written {} bytes to {}", content.len(), path) }])
}

fn cmd_edit(args: &HashMap<String, serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    let path = get_string_arg(args, "path")?;
    let old_text = get_string_arg(args, "old_text")?;
    let new_text = get_string_arg(args, "new_text")?;

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path, e))?;

    // Count occurrences
    let occurrences = content.matches(&old_text).count();
    if occurrences == 0 {
        return Err(format!("oldText not found in {}. Check exact text.", path));
    }

    let new_content = content.replace(&old_text, &new_text);
    std::fs::write(&path, &new_content)
        .map_err(|e| format!("Failed to write {}: {}", path, e))?;

    Ok(vec![ContentBlock::Text {
        text: format!("Replaced {} occurrence(s) in {}", occurrences, path),
    }])
}

fn cmd_bash(args: &HashMap<String, serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    let command = get_string_arg(args, "command")?;
    let timeout_secs = args.get("timeout")
        .and_then(|v| v.as_f64())
        .unwrap_or(30.0) as u64;

    // Use cmd.exe on Windows, sh on Unix
    let shell = if cfg!(target_os = "windows") { "cmd.exe" } else { "sh" };
    let flag = if cfg!(target_os = "windows") { "/C" } else { "-c" };

    let output = Command::new(shell)
        .arg(flag)
        .arg(&command)
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let mut result = String::new();
    if !output.stdout.is_empty() {
        let stdout_str = String::from_utf8_lossy(&output.stdout);
        result.push_str(&stdout_str);
    }
    if !output.stderr.is_empty() {
        let stderr_str = String::from_utf8_lossy(&output.stderr);
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(&format!("STDERR:\n{}", stderr_str));
    }

    if result.len() > 50_000 {
        // Char-safe truncation (never split a multi-byte UTF-8 char)
        let truncated: String = result.chars().take(50_000).collect();
        result = format!("{}... [truncated {} total bytes]", truncated, result.len());
    }

    if result.is_empty() {
        result = format!("Command completed with exit code: {}", output.status.code().unwrap_or(-1));
    }

    Ok(vec![ContentBlock::Text { text: result }])
}

fn cmd_web_search(args: &HashMap<String, serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    let query = get_string_arg(args, "query")?;
    let result = crate::web_search::search_web(&query);
    Ok(vec![ContentBlock::Text { text: serde_json::to_string_pretty(&result).unwrap_or_default() }])
}

fn cmd_fetch_url(args: &HashMap<String, serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    let url = get_string_arg(args, "url")?;
    let result = crate::web_search::fetch_url(&url);
    Ok(vec![ContentBlock::Text { text: serde_json::to_string_pretty(&result).unwrap_or_default() }])
}

fn cmd_browser_navigate(args: &HashMap<String, serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    let url = get_string_arg(args, "url")?;
    let max_len = args.get("max_text_length").and_then(|v| v.as_u64()).map(|v| v as usize);
    let result = crate::agent_browser::browser_navigate(&url, max_len);
    let text = if let Some(title) = result["title"].as_str() {
        if title != "Untitled" {
            format!("Title: {}\n\n{}", title, result["text"].as_str().unwrap_or(""))
        } else {
            result["text"].as_str().unwrap_or("").to_string()
        }
    } else {
        result["text"].as_str().unwrap_or("").to_string()
    };
    Ok(vec![ContentBlock::Text { text }])
}

fn cmd_browser_screenshot(args: &HashMap<String, serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    let url = args.get("url").and_then(|v| v.as_str());
    let result = crate::agent_browser::browser_screenshot(url);
    Ok(vec![ContentBlock::Text { text: serde_json::to_string_pretty(&result).unwrap_or_default() }])
}

fn cmd_browser_evaluate(args: &HashMap<String, serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    let code = get_string_arg(args, "code")?;
    let result = crate::agent_browser::browser_evaluate(&code);
    Ok(vec![ContentBlock::Text { text: serde_json::to_string_pretty(&result).unwrap_or_default() }])
}

// ── Shared helpers ──

/// Char-safe truncation: never splits a multi-byte UTF-8 character.
pub fn truncate_chars_safe(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_chars_safe_ascii() {
        assert_eq!(truncate_chars_safe("hello world", 5), "hello");
        assert_eq!(truncate_chars_safe("hello", 100), "hello");
    }

    #[test]
    fn test_truncate_chars_safe_multibyte() {
        // Multi-byte UTF-8: 5000 emoji chars (4 bytes each = 20000 bytes)
        let s = "😀".repeat(5000);
        let truncated = truncate_chars_safe(&s, 2000);
        assert_eq!(truncated, "😀".repeat(2000));
        assert!(truncated.is_char_boundary(truncated.len()));
        // Every truncation must land on a char boundary
        for n in [1usize, 3, 7, 999, 2000] {
            let t = truncate_chars_safe(&s, n);
            assert!(t.is_char_boundary(t.len()));
            assert_eq!(t.chars().count(), n);
        }
    }

    #[test]
    fn test_truncate_chars_safe_mixed() {
        let s = "héllo wörld — 你好 😀";
        let truncated = truncate_chars_safe(s, 9);
        assert!(truncated.is_char_boundary(truncated.len()));
        assert_eq!(truncated.chars().count(), 9);
    }

    #[test]
    fn test_cmd_read_offset() {
        use std::collections::HashMap;
        let dir = std::env::temp_dir().join("pi-agent-tools-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("offset_test.txt");
        let content: String = (1..=100).map(|i| format!("line {}", i)).collect::<Vec<_>>().join("\n");
        std::fs::write(&path, &content).unwrap();

        let mut args = HashMap::new();
        args.insert("path".to_string(), serde_json::json!(path.to_string_lossy()));
        let blocks = cmd_read(&args).unwrap();
        let text = match &blocks[0] {
            ContentBlock::Text { text } => text.clone(),
            _ => String::new(),
        };
        assert!(text.starts_with("line 1"), "offset=1 must start at line 1, got: {}", &text[..text.len().min(40)]);

        // offset=50
        let mut args = HashMap::new();
        args.insert("path".to_string(), serde_json::json!(path.to_string_lossy()));
        args.insert("offset".to_string(), serde_json::json!(50));
        let blocks = cmd_read(&args).unwrap();
        let text = match &blocks[0] {
            ContentBlock::Text { text } => text.clone(),
            _ => String::new(),
        };
        assert!(text.starts_with("line 50"), "offset=50 must start at line 50, got: {}", &text[..text.len().min(40)]);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_cmd_read_non_ascii_no_panic() {
        use std::collections::HashMap;
        let dir = std::env::temp_dir().join("pi-agent-tools-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("unicode_test.txt");
        // 6000 emoji chars — each 4 bytes, total 24000 bytes + newlines
        let content = (0..6000).map(|i| format!("line {} 😀", i)).collect::<Vec<_>>().join("\n");
        std::fs::write(&path, &content).unwrap();

        let mut args = HashMap::new();
        args.insert("path".to_string(), serde_json::json!(path.to_string_lossy()));
        let blocks = cmd_read(&args).unwrap();
        let text = match &blocks[0] {
            ContentBlock::Text { text } => text.clone(),
            _ => String::new(),
        };
        // Must not panic on multibyte content
        assert!(text.contains("😀") || text.contains("truncated"));
        std::fs::remove_file(&path).ok();
    }
}
