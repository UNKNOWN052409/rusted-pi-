/// Compaction threshold checking for context management.
///
/// Provides the `should-compact` command that determines whether
/// context usage exceeds configured thresholds.
///
/// Input:  `compaction-should-compact {"contextTokens": 75000, "contextWindow": 128000, "reserveTokens": 16384, "thresholds": [0.6, 0.8]}`
/// Output: `{"shouldCompact": true, "reason": "usage 0.59 exceeds threshold 0.6", "usagePercent": 0.59, "thresholdHit": 0.6}`

use serde_json::{json, Value};

/// Check if compaction should be triggered based on context usage.
pub fn handle_should_compact(input_json: &str) -> Value {
    let input: Value = match serde_json::from_str(input_json) {
        Ok(v) => v,
        Err(e) => return json!({"error": format!("Invalid JSON: {}", e)}),
    };

    let context_tokens = match input.get("contextTokens").and_then(|v| v.as_u64()) {
        Some(v) => v as f64,
        None => return json!({"error": "Missing 'contextTokens' (integer)"}),
    };

    let context_window = match input.get("contextWindow").and_then(|v| v.as_u64()) {
        Some(v) => v as f64,
        None => return json!({"error": "Missing 'contextWindow' (integer)"}),
    };

    if context_window <= 0.0 {
        return json!({"shouldCompact": false, "reason": "contextWindow is zero or missing"});
    }

    let usage_percent = context_tokens / context_window;

    // Check reserve-based threshold: compact if contextTokens > contextWindow - reserveTokens
    if let Some(reserve) = input.get("reserveTokens").and_then(|v| v.as_u64()) {
        let reserve = reserve as f64;
        if context_tokens > context_window - reserve {
            return json!({
                "shouldCompact": true,
                "reason": format!("context {} exceeds window {} - reserve {}", context_tokens as u64, context_window as u64, reserve as u64),
                "usagePercent": (usage_percent * 100.0).round() / 100.0,
                "thresholdHit": "reserve"
            });
        }
    }

    // Check percentage-based thresholds: compact if usage exceeds any defined threshold
    if let Some(thresholds) = input.get("thresholds").and_then(|v| v.as_array()) {
        let mut sorted: Vec<f64> = thresholds
            .iter()
            .filter_map(|t| t.as_f64())
            .filter(|&t| t > 0.0 && t < 1.0)
            .collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        for threshold in &sorted {
            if usage_percent >= *threshold {
                return json!({
                    "shouldCompact": true,
                    "reason": format!("usage {:.2} exceeds threshold {}", usage_percent, threshold),
                    "usagePercent": (usage_percent * 100.0).round() / 100.0,
                    "thresholdHit": threshold
                });
            }
        }
    }

    json!({
        "shouldCompact": false,
        "reason": "no threshold exceeded",
        "usagePercent": (usage_percent * 100.0).round() / 100.0,
        "thresholdHit": null
    })
}
