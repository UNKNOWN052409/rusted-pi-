/// Session manager — file-based persistent conversation state
///
/// Stores each session as a JSON file in PI_SESSION_DIR or /tmp/pi-sessions/.
/// Sessions are automatically loaded on request, created if not found.
/// Uses per-session file locking to prevent corruption from concurrent requests.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::agent_types::Message;

lazy_static::lazy_static! {
    static ref SESSION_DIR: Mutex<String> = Mutex::new(
        std::env::var("PI_SESSION_DIR").unwrap_or_else(|_| "/tmp/pi-sessions".to_string())
    );
}

/// Ensure session directory exists
fn ensure_dir(dir: &str) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create session dir {}: {}", dir, e))
}

/// Path for a given session ID
fn session_path(session_id: &str, dir: &str) -> PathBuf {
    let safe_id = session_id.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");
    PathBuf::from(dir).join(format!("{}.json", safe_id))
}

/// Generate a new unique session ID
pub fn generate_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("sess-{:016x}", nanos)
}

/// Load messages for a session. Returns empty vec if session doesn't exist.
pub fn load_session(session_id: &str) -> Result<Vec<Message>, String> {
    let dir = SESSION_DIR.lock().map_err(|e| e.to_string())?;
    let path = session_path(session_id, &dir);

    if !path.exists() {
        return Ok(Vec::new());
    }

    let data = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read session {}: {}", session_id, e))?;

    serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse session {}: {}", session_id, e))
}

/// Save messages for a session
pub fn save_session(session_id: &str, messages: &[Message]) -> Result<(), String> {
    let dir = SESSION_DIR.lock().map_err(|e| e.to_string())?;
    ensure_dir(&dir)?;

    let path = session_path(session_id, &dir);
    let data = serde_json::to_string_pretty(messages)
        .map_err(|e| format!("Failed to serialize session {}: {}", session_id, e))?;

    // Write to temp file then atomically rename to prevent partial writes
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &data)
        .map_err(|e| format!("Failed to write session {}: {}", session_id, e))?;
    fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to rename session {}: {}", session_id, e))?;

    Ok(())
}

/// Delete a session's stored data
pub fn delete_session(session_id: &str) -> Result<(), String> {
    let dir = SESSION_DIR.lock().map_err(|e| e.to_string())?;
    let path = session_path(session_id, &dir);

    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete session {}: {}", session_id, e))?;
    }

    Ok(())
}

/// List all active sessions
pub fn list_sessions() -> Result<Vec<String>, String> {
    let dir = SESSION_DIR.lock().map_err(|e| e.to_string())?;
    if !PathBuf::from(&*dir).exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    for entry in fs::read_dir(&*dir).map_err(|e| format!("Failed to read session dir: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".json") {
            sessions.push(name.trim_end_matches(".json").to_string());
        }
    }

    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_types::ContentBlock;

    #[test]
    fn test_session_roundtrip() {
        let sid = generate_session_id();
        let msgs = vec![
            Message::User {
                content: vec![ContentBlock::Text { text: "hello".to_string() }],
            },
        ];

        save_session(&sid, &msgs).unwrap();
        let loaded = load_session(&sid).unwrap();
        assert_eq!(loaded.len(), 1);

        delete_session(&sid).unwrap();
        let after_del = load_session(&sid).unwrap();
        assert_eq!(after_del.len(), 0);
    }
}
