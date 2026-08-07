/// URL → API format detection (port of custom-provider.ts detectApiFromUrl)
/// Uses only the `url` crate for parsing, returns JSON for the JS bridge.

use url::Url;

pub fn detect_api_from_url(raw_url: &str) -> serde_json::Value {
	let parsed = match Url::parse(raw_url) {
		Ok(u) => u,
		Err(_) => {
			// Try with https:// prefix
			match Url::parse(&format!("https://{}", raw_url)) {
				Ok(u) => u,
				Err(_) => {
					return serde_json::json!({
						"api": "openai-completions",
						"confidence": 0.3,
						"providerName": "Custom Provider",
						"isKnownProvider": false
					});
				}
			}
		}
	};

	let hostname = parsed.host_str().unwrap_or("").to_lowercase();
	let pathname = parsed.path().to_lowercase();

	// Well-known providers (high confidence)
	if hostname.contains("anthropic") {
		return serde_json::json!({
			"api": "anthropic-messages",
			"confidence": 0.95,
			"providerName": "Anthropic (Custom)",
			"isKnownProvider": true
		});
	}
	if hostname.contains("azure.com") || hostname.contains("azure.net") || hostname.contains("azurefd.net") {
		return serde_json::json!({
			"api": "azure-openai-responses",
			"confidence": 0.95,
			"providerName": "Azure OpenAI",
			"isKnownProvider": true
		});
	}
	if hostname.contains("googleapis.com") || hostname.contains("google.ai") || hostname.contains("generativelanguage") {
		return serde_json::json!({
			"api": "google-generative-ai",
			"confidence": 0.9,
			"providerName": "Google AI (Custom)",
			"isKnownProvider": true
		});
	}
	if hostname.contains("openai.com") {
		return serde_json::json!({
			"api": "openai-responses",
			"confidence": 0.9,
			"providerName": "OpenAI Compatible",
			"isKnownProvider": true
		});
	}
	if hostname.contains("mistral.ai") || hostname.contains("mistral") {
		return serde_json::json!({
			"api": "mistral-conversations",
			"confidence": 0.85,
			"providerName": "Mistral (Custom)",
			"isKnownProvider": true
		});
	}

	// Path-based detection (medium confidence)
	if pathname.contains("/v1/messages") {
		return serde_json::json!({
			"api": "anthropic-messages",
			"confidence": 0.8,
			"providerName": "Anthropic Compatible",
			"isKnownProvider": false
		});
	}
	if pathname.contains("/chat/completions") || pathname.contains("/v1/completions") {
		return serde_json::json!({
			"api": "openai-completions",
			"confidence": 0.85,
			"providerName": "OpenAI Compatible",
			"isKnownProvider": false
		});
	}
	if pathname.contains("/v1/responses") {
		return serde_json::json!({
			"api": "openai-responses",
			"confidence": 0.85,
			"providerName": "OpenAI Responses Compatible",
			"isKnownProvider": false
		});
	}

	// Query-param style endpoints
	if parsed.query_pairs().count() > 0 {
		return serde_json::json!({
			"api": "openai-completions",
			"confidence": 0.45,
			"providerName": "Custom API (query-param)",
			"isKnownProvider": false
		});
	}

	// Known custom proxy platforms
	if hostname == "prexzyapis.com" || hostname.ends_with(".prexzyapis.com") {
		return serde_json::json!({
			"api": "openai-completions",
			"confidence": 0.7,
			"providerName": "Prexzy API",
			"isKnownProvider": false
		});
	}
	if hostname == "burger-king.com.tr" || hostname.ends_with(".burger-king.com.tr") {
		return serde_json::json!({
			"api": "openai-completions",
			"confidence": 0.6,
			"providerName": "Custom Provider (BK)",
			"isKnownProvider": false
		});
	}
	if hostname == "scnet.ai" || hostname.ends_with(".scnet.ai") {
		return serde_json::json!({
			"api": "openai-completions",
			"confidence": 0.6,
			"providerName": "SCNet AI",
			"isKnownProvider": false
		});
	}

	// Unknown domain fallback
	serde_json::json!({
		"api": "openai-completions",
		"confidence": 0.3,
		"providerName": "Custom Provider",
		"isKnownProvider": false
	})
}
