/// Browser navigation tool — fetch + parse HTML (headless, no JS)
///
/// Commands:
///   browser_navigate {"url":"...","max_text_length":16000}
///   browser_screenshot {"url":"..."}
///   browser_evaluate {"code":"..."}  — may be unavailable

/// Safe UTF-8 truncation: keep first `max` characters, not bytes.
fn truncate_utf8(s: &str, max: usize) -> &str {
    let mut idx = 0;
    for (i, _) in s.char_indices() {
        if i >= max {
            break;
        }
        idx = i;
    }
    // idx is the byte offset of the last complete char before max
    if idx == 0 && s.len() > max {
        // max landed before first char — just take max bytes (may still be safe if ASCII)
        &s[..s.char_indices().nth(max).map(|(i,_)| i).unwrap_or(s.len())]
    } else {
        &s[..s.char_indices().nth(max).map(|(i,_)| i).unwrap_or(s.len())]
    }
}

/// Truncate to at most `max` characters (safe UTF-8)
fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

pub fn browser_navigate(url: &str, max_text_length: Option<usize>) -> serde_json::Value {
    let max_len = max_text_length.unwrap_or(16000);
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .timeout_read(std::time::Duration::from_secs(30))
        .redirects(5)
        .build();

    let response = match agent
        .get(url)
        .set("User-Agent", "Mozilla/5.0 (compatible; PiAgentBrowser/1.0; +https://pi-coding-agent)")
        .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .call()
    {
        Ok(r) => r,
        Err(e) => {
            return serde_json::json!({
                "success": false,
                "error": format!("Request failed: {}", e),
                "url": url
            });
        }
    };

    let status = response.status();
    let html = match response.into_string() {
        Ok(s) => s,
        Err(e) => {
            return serde_json::json!({
                "success": false,
                "error": format!("Failed to read response body: {}", e),
                "url": url
            });
        }
    };

    let title = extract_title(&html);
    let text = extract_text(&html);
    let (truncated_text, truncated_note) = if text.len() > max_len {
        let safe = truncate_chars(&text, max_len);
        (safe, Some(format!("truncated from {} chars", text.len())))
    } else {
        (text, None)
    };
    let links = extract_links(&html, url);
    let (html_snippet, html_note) = if html.len() > 50000 {
        let safe = truncate_chars(&html, 50000);
        (safe, Some(format!("truncated from {} total chars", html.len())))
    } else {
        (html, None)
    };

    let mut result = serde_json::json!({
        "success": true,
        "url": url,
        "title": title,
        "text": truncated_text,
        "links": links,
        "html": html_snippet,
        "status": status
    });
    if let Some(note) = truncated_note {
        result["text_truncated"] = serde_json::Value::String(note);
    }
    if let Some(note) = html_note {
        result["html_truncated"] = serde_json::Value::String(note);
    }

    result
}

/// Screenshot — unavailable in headless mode (no GUI)
pub fn browser_screenshot(url: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "tool": "browser_screenshot",
        "info": if let Some(u) = url {
            format!("Screenshot requested for {}. Lightweight mode: no GUI available. Use browser_navigate to fetch page content.", u)
        } else {
            "Screenshot requested. Lightweight mode: no GUI available. Use browser_navigate to fetch page content.".to_string()
        }
    })
}

/// Evaluate JS — unavailable in headless mode (no JS engine)
pub fn browser_evaluate(code: &str) -> serde_json::Value {
    let safe = truncate_chars(code, 200);
    serde_json::json!({
        "evaluated": false,
        "reason": format!("JS execution requires puppeteer/playwright. Code received ({} chars): {}", code.len(), safe)
    })
}

// ── HTML Parsing ──

fn extract_title(html: &str) -> String {
    if let Some(start) = html.find("<title") {
        if let Some(bracket) = html[start..].find('>') {
            let content_start = start + bracket + 1;
            if let Some(end) = html[content_start..].find("</title>") {
                return html[content_start..content_start + end].trim().to_string();
            }
        }
    }
    "Untitled".to_string()
}

fn extract_text(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut chars = html.chars();
    let mut in_tag = false;
    let mut in_script = 0;
    let mut in_style = 0;
    // Position tracking for `remaining` lookahead (approximate)
    let mut pos: usize = 0;

    while let Some(ch) = chars.next() {
        if ch == '<' {
            let remaining = &html[pos..];
            let lower = remaining.to_lowercase();

            if lower.starts_with("<script") {
                in_script += 1;
                in_tag = true;
                pos += 1;
                continue;
            }
            if in_script > 0 && lower.starts_with("</script") {
                in_script -= 1;
                in_tag = true;
                pos += 1;
                continue;
            }
            if lower.starts_with("<style") {
                in_style += 1;
                in_tag = true;
                pos += 1;
                continue;
            }
            if in_style > 0 && lower.starts_with("</style") {
                in_style -= 1;
                in_tag = true;
                pos += 1;
                continue;
            }

            if in_script == 0 && in_style == 0 {
                // Block-level close tag → newline
                if lower.starts_with("</") {
                    let rest = &lower[2..];
                    let close_tag = rest.split(|c: char| c == '>' || c == ' ').next().unwrap_or("");
                    if matches!(close_tag, "p" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "tr" | "blockquote" | "section" | "article") {
                        if !result.ends_with('\n') {
                            result.push('\n');
                        }
                    }
                }
                // <br> → newline
                if lower.starts_with("<br") {
                    result.push('\n');
                }
            }

            in_tag = true;
            pos += 1;
            continue;
        }

        if ch == '>' && in_tag {
            in_tag = false;
            pos += 1;
            continue;
        }

        if in_tag || in_script > 0 || in_style > 0 {
            pos += 1;
            continue;
        }

        // Decode common entities (use remaining for entity lookahead)
        if ch == '&' {
            let remaining = &html[pos..];
            if remaining.starts_with("&amp;") { result.push('&'); pos += 5; continue; }
            if remaining.starts_with("&lt;") { result.push('<'); pos += 4; continue; }
            if remaining.starts_with("&gt;") { result.push('>'); pos += 4; continue; }
            if remaining.starts_with("&quot;") { result.push('"'); pos += 6; continue; }
            if remaining.starts_with("&#x27;") { result.push('\''); pos += 6; continue; }
            if remaining.starts_with("&#x2F;") { result.push('/'); pos += 6; continue; }
            if remaining.starts_with("&nbsp;") { result.push(' '); pos += 6; continue; }
        }

        if ch.is_ascii_whitespace() {
            if !result.ends_with(' ') && !result.ends_with('\n') && !result.is_empty() {
                result.push(' ');
            }
        } else {
            result.push(ch);
        }
        pos += ch.len_utf8();
    }

    // Clean up: collapse multiple newlines, trim
    let mut cleaned = String::with_capacity(result.len());
    let mut prev_newline = false;
    for ch in result.chars() {
        if ch == '\n' {
            if !prev_newline {
                cleaned.push('\n');
            }
            prev_newline = true;
        } else {
            cleaned.push(ch);
            prev_newline = false;
        }
    }

    cleaned.trim().to_string()
}

fn extract_links(html: &str, base_url: &str) -> Vec<serde_json::Value> {
    let mut links = Vec::new();
    let lower = html.to_lowercase();
    let mut search_start = 0;

    while let Some(tag_start) = html[search_start..].find('<') {
        let abs_start = search_start + tag_start;
        // Check if this is <a or </a
        let rest_lower = &lower[abs_start..];
        if !rest_lower.starts_with("<a ") && !rest_lower.starts_with("<a>") {
            search_start = abs_start + 1;
            continue;
        }

        // Find href="..." inside the tag
        let tag_html = &html[abs_start..];
        let tag_lower = &lower[abs_start..];
        if let Some(href_attr) = tag_lower.find("href=\"") {
            let href_content_start = abs_start + href_attr + 6;
            if let Some(quote_end) = html[href_content_start..].find('"') {
                let href = &html[href_content_start..href_content_start + quote_end];

                if !href.starts_with('#') && !href.starts_with("javascript:") {
                    let resolved = resolve_url(href, base_url);

                    // Get link text (up to </a>)
                    let after_close = tag_html.find('>').map(|p| p + 1).unwrap_or(0);
                    let text_start = abs_start + after_close;
                    let text_end = html[text_start..].find("</a>").unwrap_or(0);
                    let link_text = if text_end > 0 {
                        extract_text(&html[text_start..text_start + text_end])
                    } else {
                        String::new()
                    };

                    links.push(serde_json::json!({
                        "href": resolved,
                        "text": if link_text.is_empty() { resolved } else { link_text }
                    }));
                }
            }
        }

        search_start = abs_start + 1;
    }

    links
}

fn resolve_url(href: &str, base: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }

    if href.starts_with('/') {
        // Absolute path — resolve against scheme+host
        if let Some(scheme_end) = base.find("://") {
            let after_scheme = scheme_end + 3;
            let host_end = base[after_scheme..].find('/')
                .map(|p| after_scheme + p)
                .unwrap_or(base.len());
            format!("{}{}", &base[..host_end], href)
        } else {
            format!("{}{}", base, href)
        }
    } else {
        // Relative path
        if base.ends_with('/') {
            // Base ends with / → treat as directory, append relative
            format!("{}{}", base, href)
        } else if let Some(last_slash) = base.rfind('/') {
            let scheme_end = base.find("://").map(|p| p + 3).unwrap_or(0);
            if last_slash > scheme_end {
                // Strip filename part, keep path up to last slash
                format!("{}/{}", &base[..=last_slash], href)
            } else {
                format!("{}/{}", base, href)
            }
        } else {
            format!("{}/{}", base, href)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_title() {
        let html = "<html><head><title>Test Page</title></head><body>Hello</body></html>";
        assert_eq!(extract_title(html), "Test Page");
    }

    #[test]
    fn test_extract_text() {
        let html = "<html><body><h1>Hello</h1><p>World</p></body></html>";
        let text = extract_text(html);
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
    }

    #[test]
    fn test_extract_links() {
        let html = r#"<a href="https://example.com">Example</a>"#;
        let links = extract_links(html, "https://base.com");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0]["href"], "https://example.com");
    }

    #[test]
    fn test_resolve_url() {
        assert_eq!(resolve_url("/foo", "https://example.com"), "https://example.com/foo");
        assert_eq!(resolve_url("foo", "https://example.com/path/"), "https://example.com/path/foo");
        assert_eq!(resolve_url("https://other.com", "https://example.com"), "https://other.com");
    }
}
