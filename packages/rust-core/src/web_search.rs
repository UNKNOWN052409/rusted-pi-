/// Web search + URL content fetch using ureq HTTP client.
/// Commands:
///   fetch-url {"url":"..."}     — fetch and return HTML text content
///   search-web {"query":"..."}  — search DuckDuckGo HTML and extract results

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

pub fn fetch_url(url: &str) -> serde_json::Value {
	let agent = ureq::AgentBuilder::new()
		.timeout_connect(std::time::Duration::from_secs(10))
		.timeout_read(std::time::Duration::from_secs(15))
		.redirects(5)
		.build();

	let response = match agent
		.get(url)
		.set("User-Agent", USER_AGENT)
		.set("Accept", "text/html,application/json,*/*")
		.call()
	{
		Ok(r) => r,
		Err(e) => {
			return serde_json::json!({
				"success": false,
				"error": format!("Request failed: {}", e)
			});
		}
	};

	let status = response.status();
	let body = match response.into_string() {
		Ok(s) => s,
		Err(e) => {
			return serde_json::json!({
				"success": false,
				"error": format!("Failed to read response body: {}", e)
			});
		}
	};

	let text = strip_html(&body);
	let text = if text.len() > 50_000 {
		format!("{}... [truncated {} chars]", &text[..50_000], text.len())
	} else {
		text
	};

	serde_json::json!({
		"success": true,
		"status": status,
		"text": text,
		"length": text.len(),
		"url": url
	})
}

pub fn search_web(query: &str) -> serde_json::Value {
	let encoded: String = url::form_urlencoded::Serializer::new(String::new())
		.append_pair("q", query)
		.finish();

	let search_url = format!("https://html.duckduckgo.com/html/?{}", encoded);
	let results = fetch_url(&search_url);

	if !results["success"].as_bool().unwrap_or(false) {
		return results;
	}

	let html = results["text"].as_str().unwrap_or("");
	let links = extract_search_links(html);

	serde_json::json!({
		"success": true,
		"query": query,
		"results": links,
		"resultCount": links.len()
	})
}

/// Naive HTML tag stripping for text extraction
fn strip_html(html: &str) -> String {
	let mut result = String::with_capacity(html.len());
	let mut in_tag = false;
	let mut in_script = false;
	let mut in_style = false;

	let bytes = html.as_bytes();
	let mut i = 0;
	while i < bytes.len() {
		if in_script || in_style {
			if bytes[i] == b'<' && i + 1 < bytes.len() {
				if (in_script && i + 7 < bytes.len() && bytes[i..].starts_with(b"</script"))
					|| (in_style && i + 6 < bytes.len() && bytes[i..].starts_with(b"</style"))
				{
					in_script = false;
					in_style = false;
					in_tag = true;
				}
			}
			i += 1;
			continue;
		}

		if bytes[i] == b'<' {
			in_tag = true;
			if i + 6 < bytes.len() {
				let lower = html[i..i+7].to_lowercase();
				if lower.starts_with("<script") { in_script = true; }
				if lower.starts_with("<style") { in_style = true; }
			}
			i += 1;
			continue;
		}

		if bytes[i] == b'>' && in_tag {
			in_tag = false;
			i += 1;
			continue;
		}

		if in_tag {
			i += 1;
			continue;
		}

		if bytes[i].is_ascii_whitespace() {
			if !result.ends_with(' ') && !result.is_empty() {
				result.push(' ');
			}
		} else {
			result.push(bytes[i] as char);
		}
		i += 1;
	}

	result
}

/// Extract search result links from DuckDuckGo HTML
fn extract_search_links(text: &str) -> Vec<serde_json::Value> {
	let mut links = Vec::new();
	let lines: Vec<&str> = text.lines().collect();
	let mut i = 0;

	while i < lines.len() {
		let line = lines[i];

		if line.contains("result__url") || line.contains("result__a") {
			let mut url = String::new();
			let mut title = String::new();

			for j in i..(i + 5).min(lines.len()) {
				let l = lines[j];
				if let Some(start) = l.find("http://").or_else(|| l.find("https://")) {
					let end = l[start..].find(|c: char| c.is_whitespace() || c == '"' || c == '<')
						.map(|e| start + e)
						.unwrap_or(l.len());
					url = l[start..end].to_string();
					break;
				}
			}

			for j in i.saturating_sub(2)..(i + 3).min(lines.len()) {
				let l = lines[j].trim();
				if l.len() > 5 && l.len() < 200 && !l.contains("http") && !l.starts_with("result") && !l.starts_with("//") {
					title = l.to_string();
					break;
				}
			}

			if !url.is_empty() {
				links.push(serde_json::json!({
					"title": title,
					"url": url
				}));
			}
		}

		i += 1;
	}

	links
}
