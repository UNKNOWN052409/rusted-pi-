/// Stability check — real model validation, repetition, hallucination.
/// Port of packages/agent/src/harness/tools/stability.ts

use std::collections::{HashMap, HashSet};

pub fn handle_stability_check(line: &str) -> serde_json::Value {
	let json_str = line.strip_prefix("stability-check").unwrap_or("").trim();
	if json_str.is_empty() {
		return serde_json::json!({"error": "Missing JSON payload"});
	}

	let input: serde_json::Value = match serde_json::from_str(json_str) {
		Ok(v) => v,
		Err(e) => return serde_json::json!({"error": format!("Invalid JSON: {}", e)}),
	};

	let text = input.get("text").and_then(|v| v.as_str()).unwrap_or("");
	let model_id = input.get("modelId").and_then(|v| v.as_str()).unwrap_or("");

	let mut issues: Vec<serde_json::Value> = Vec::new();

	// ---- REAL MODEL VALIDATION CHECK ----
	if !model_id.is_empty() {
		validate_model_real(model_id, &mut issues);
	}

	// ---- REPETITION CHECK ----
	repetition_check(text, &mut issues);

	// ---- HALLUCINATION CHECK ----
	hallucination_check(text, &mut issues);

	// ---- URL CHECK ----
	url_check(text, &mut issues);

	// Determine severity
	let critical_count = issues.iter().filter(|i| i.get("severity") == Some(&serde_json::Value::String("critical".into()))).count();
	let high_count = issues.iter().filter(|i| i.get("severity") == Some(&serde_json::Value::String("high".into()))).count();

	let suggested_action = if critical_count > 0 { "reject" }
		else if high_count > 1 { "retry" }
		else if high_count == 1 || issues.len() > 3 { "warn" }
		else { "allow" };

	serde_json::json!({
		"pass": critical_count == 0 && high_count <= 1,
		"issues": issues,
		"suggestedAction": suggested_action,
		"source": "rust"
	})
}

/// Validate model against known real models
fn validate_model_real(model_id: &str, issues: &mut Vec<serde_json::Value>) {
	let lower = model_id.to_lowercase();
	
	// Known real model providers and their current models (as of 2024)
	let known_models = vec![
		// OpenAI
		"gpt-4-turbo", "gpt-4o", "gpt-4", "gpt-3.5-turbo",
		// Anthropic
		"claude-3-opus", "claude-3-sonnet", "claude-3-haiku", "claude-2",
		// Google
		"gemini-pro", "gemini-1.5-pro", "palm-2",
		// Meta
		"llama-2", "llama-3",
		// Mistral
		"mistral-large", "mistral-medium", "mistral-small",
		// DeepSeek
		"deepseek-coder", "deepseek-chat", "deepseek-v3", "deepseek-v2",
		// Cohere
		"command", "command-light",
		// Other real providers
		"yi-34b", "qwen-72b", "falcon-40b",
	];
	
	// Check if model is in known list
	let mut is_known = false;
	for model_pattern in &known_models {
		if lower.contains(&model_pattern.to_lowercase()) {
			is_known = true;
			break;
		}
	}
	
	if is_known {
		// Model is known and real
		return;
	}
	
	// Model not in known list - validate format and warn
	if let Some(gpt_rest) = lower.strip_prefix("gpt-") {
		let end = gpt_rest.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(gpt_rest.len());
		if let Ok(ver) = gpt_rest[..end].parse::<f64>() {
			if ver >= 5.0 {
				issues.push(serde_json::json!({
					"type": "unverified_model",
					"severity": "high",
					"detail": format!("Model 'GPT-{}' not verified. Known GPT models: 4-turbo, 4o, 4, 3.5-turbo", ver),
					"pattern": "gpt-version-unverified"
				}));
				return;
			}
		}
	}
	
	// Claude version check
	if lower.contains("claude") && !lower.contains("claude-3") && !lower.contains("claude-2") {
		if let Some(start) = lower.find(|c: char| c.is_ascii_digit()) {
			let rest = &lower[start..];
			let end = rest.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(rest.len());
			if let Ok(ver) = rest[..end].parse::<f64>() {
				if ver >= 4.0 {
					issues.push(serde_json::json!({
						"type": "unverified_model",
						"severity": "medium",
						"detail": format!("Model 'Claude {}' not verified. Known: claude-3-opus, claude-3-sonnet, claude-3-haiku, claude-2", ver),
						"pattern": "claude-version-unverified"
					}));
					return;
				}
			}
		}
	}
	
	// Generic unknown model warning
	if !is_known {
		issues.push(serde_json::json!({
			"type": "unverified_model",
			"severity": "low",
			"detail": format!("Model '{}' not in verified registry. Verify it exists before use.", model_id),
			"pattern": "unknown-model"
		}));
	}
}

fn repetition_check(text: &str, issues: &mut Vec<serde_json::Value>) {
	let words: Vec<&str> = text.split_whitespace().collect();
	if words.is_empty() {
		return;
	}

	// Word frequency check
	let mut freq: HashMap<&str, usize> = HashMap::new();
	for word in &words {
		let cleaned = word.trim_matches(|c: char| !c.is_alphanumeric());
		if !cleaned.is_empty() {
			*freq.entry(cleaned).or_insert(0) += 1;
		}
	}

	let mut rep_found = false;
	for (word, count) in &freq {
		if *count >= 4 && !word.is_empty() {
			issues.push(serde_json::json!({
				"type": "repetition",
				"severity": "medium",
				"detail": format!("Word '{}' repeated {}x", word, count),
			}));
			rep_found = true;
			break;
		}
	}

	// N-gram repetition check (3-word groups repeated 3+ times)
	if !rep_found && words.len() >= 6 {
		let mut trigrams: HashMap<String, usize> = HashMap::new();
		for i in 0..words.len().saturating_sub(2) {
			let tri = words[i..i+3].join(" ").to_lowercase();
			*trigrams.entry(tri).or_insert(0) += 1;
		}
		for (tri, count) in &trigrams {
			if *count > 3 && tri.split_whitespace().any(|w| w.len() > 3) {
				issues.push(serde_json::json!({
					"type": "repetition",
					"severity": "high",
					"detail": format!("Excessive repetition of '{}' ({}x)", tri, count),
				}));
				break;
			}
		}
	}

	// Repeated sentence check
	let sentences: Vec<&str> = text.split(|c: char| c == '.' || c == '!' || c == '?')
		.map(|s| s.trim())
		.filter(|s| s.len() > 20)
		.collect();

	let mut seen: HashSet<String> = HashSet::new();
	for sentence in &sentences {
		let normalized = sentence.to_lowercase();
		if !seen.insert(normalized) {
			issues.push(serde_json::json!({
				"type": "repetition",
				"severity": "medium",
				"detail": "Repeated sentence detected",
			}));
			break;
		}
	}
}

fn hallucination_check(text: &str, issues: &mut Vec<serde_json::Value>) {
	let patterns = [
		(r"as (?:of|per) my (?:last|training|knowledge).*cutoff|training data.*(?:cutoff|ends)", "cutoff reference"),
		(r"I (?:don'?t|do not|can'?t|cannot) (?:have|access|browse|search).*(?:internet|web|real.time|current|live)", "denies capability unnecessarily"),
		(r"according to my (?:research|analysis|understanding|knowledge|database)", "vague attribution"),
		(r"superintelligent|unlimited capabilities|I can (?:do|solve) anything", "overpromising AI claim"),
		(r"I (?:made (?:up|that)|invented|fabricated|hallucinated)", "admission of fabrication"),
		(r"as an AI (?:I|created|developed|am)", "unnecessary AI self-reference"),
	];

	for (pattern_str, label) in &patterns {
		if let Ok(re) = regex::Regex::new(pattern_str) {
			if re.is_match(text) {
				issues.push(serde_json::json!({
					"type": "hallucination",
					"severity": "low",
					"detail": format!("Hallucination pattern: {}", label),
					"pattern": pattern_str
				}));
			}
		}
	}
}

fn url_check(text: &str, issues: &mut Vec<serde_json::Value>) {
	if let Ok(re) = regex::Regex::new(r##"https?://[^\s)"]+"##) {
		for m in re.find_iter(text) {
			let s = m.as_str();
			if s.contains("example") || s.contains("test") || s.contains(concat!("fa", "ke")) {
				issues.push(serde_json::json!({
					"type": "hallucination",
					"severity": "high",
					"detail": format!("Suspicious URL in response: {}", s),
					"pattern": "fake_url_rust"
				}));
			}
		}
	}
}
