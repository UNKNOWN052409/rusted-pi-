/// Pi Native — multi‑function CLI.
///
/// Communicates via stdin/stdout JSON line protocol.
/// New commands are added as modules under src/ and routed here.

mod cpu;
mod gpu;
mod stability;
mod url_detect;
mod web_search;
mod compaction;

use std::io::{self, BufRead, Write};

fn main() {
	let stdin = io::stdin();
	let stdout = io::stdout();
	let mut lines = stdin.lock().lines();

	while let Some(Ok(line)) = lines.next() {
		let trimmed = line.trim();
		if trimmed.is_empty() || trimmed.starts_with('#') {
			continue;
		}

		let result = route_command(trimmed);

		let output = serde_json::to_string(&result).unwrap_or_else(|e| {
			serde_json::json!({"error": e.to_string()}).to_string()
		});
		let mut out = stdout.lock();
		let _ = writeln!(out, "{}", output);
		let _ = out.flush();
	}
}

fn route_command(cmd: &str) -> serde_json::Value {
	match cmd {
		// System commands
		"detect-gpu" => gpu::detect_gpu(),
		"cpu-load" => {
			let load = cpu::measure_cpu_load();
			let cores = cpu::num_cpus();
			serde_json::json!({
				"load": load,
				"coreCount": cores,
				"shouldYield": load > 0.85
			})
		}
		"system-memory" => {
			serde_json::json!({ "totalMb": cpu::system_memory_mb() })
		}

		// Stability
		cmd if cmd.starts_with("stability-check") => stability::handle_stability_check(cmd),

		// URL detection
		cmd if cmd.starts_with("detect-api") => {
			// Input: "detect-api {\"url\":\"...\"}"
			let json_str = cmd.strip_prefix("detect-api").unwrap_or("").trim();
			if let Ok(input) = serde_json::from_str::<serde_json::Value>(json_str) {
				if let Some(url) = input.get("url").and_then(|v| v.as_str()) {
					return url_detect::detect_api_from_url(url);
				}
			}
			serde_json::json!({"error": "Missing 'url' field in JSON payload"})
		}

		// Web search
		cmd if cmd.starts_with("search-web") => {
			let json_str = cmd.strip_prefix("search-web").unwrap_or("").trim();
			if let Ok(input) = serde_json::from_str::<serde_json::Value>(json_str) {
				if let Some(query) = input.get("query").and_then(|v| v.as_str()) {
					return web_search::search_web(query);
				}
			}
			serde_json::json!({"error": "Missing 'query' field in JSON payload"})
		}

		// Fetch URL
		cmd if cmd.starts_with("fetch-url") => {
			let json_str = cmd.strip_prefix("fetch-url").unwrap_or("").trim();
			if let Ok(input) = serde_json::from_str::<serde_json::Value>(json_str) {
				if let Some(url) = input.get("url").and_then(|v| v.as_str()) {
					return web_search::fetch_url(url);
				}
			}
			serde_json::json!({"error": "Missing 'url' field in JSON payload"})
		}

		// Compaction
		cmd if cmd.starts_with("compaction-should-compact") => {
			let json_str = cmd.strip_prefix("compaction-should-compact").unwrap_or("").trim();
			compaction::handle_should_compact(json_str)
		}

		// Lifecycle
		"exit" | "quit" => std::process::exit(0),

		// Unknown
		_ => serde_json::json!({
			"error": format!("Unknown command: {}", cmd),
			"commands": [
				"detect-gpu", "cpu-load", "system-memory",
				"stability-check", "detect-api",
				"search-web", "fetch-url",
				"compaction-should-compact",
				"exit"
			]
		})
	}
}
