use crate::*;

fn write_log_line(app: &tauri::AppHandle, line: &str) -> Result<String, String> {
    let log_dir = get_data_dir(app).join("logs");
    if let Err(err) = std::fs::create_dir_all(&log_dir) {
        return Err(err.to_string());
    }
    let log_path = log_dir.join("mindwtr.log");
    let rotated_path = log_dir.join("mindwtr.log.1");
    let max_bytes: u64 = 5 * 1024 * 1024;

    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() >= max_bytes {
            let _ = std::fs::remove_file(&rotated_path);
            let _ = std::fs::rename(&log_path, &rotated_path);
        }
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    if let Err(err) = file.write_all(line.as_bytes()) {
        return Err(err.to_string());
    }
    if let Err(err) = file.flush() {
        return Err(err.to_string());
    }

    Ok(log_path.to_string_lossy().to_string())
}

fn native_log_line(message: &str) -> String {
    let timestamp = OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string());
    format!(
        "{}\n",
        serde_json::json!({
            "ts": timestamp,
            "level": "info",
            "scope": "app",
            "message": message,
            "context": { "source": "native" },
        })
    )
}

pub(crate) fn append_native_log_line(app: &tauri::AppHandle, message: &str) {
    let line = native_log_line(message);
    if let Err(error) = write_log_line(app, &line) {
        log::warn!("Failed to append native app log: {error}");
    }
}

// Synchronous log file I/O (open/append/flush, occasional rotation) off the
// UI thread; O_APPEND writes to this file are already safe under concurrent
// writers, and a rotation race costs at worst a diagnostic log hiccup, not
// app data (B1).
#[tauri::command(async)]
pub(crate) fn append_log_line(app: tauri::AppHandle, line: String) -> Result<String, String> {
    write_log_line(&app, &line)
}

// Diagnostics display only: under an MS Store (MSIX) install the OS silently
// redirects our Roaming AppData writes into the package's LocalCache, so the
// path the webview computes points at a file that does not exist there (#1135).
#[tauri::command]
pub(crate) fn get_log_file_path(app: tauri::AppHandle) -> String {
    let log_path = get_data_dir(&app).join("logs").join("mindwtr.log");
    crate::install::windows_store_display_path(&log_path)
        .unwrap_or(log_path)
        .to_string_lossy()
        .to_string()
}

#[tauri::command(async)]
pub(crate) fn clear_log_file(app: tauri::AppHandle) -> Result<String, String> {
    clear_log_files(&get_data_dir(&app).join("logs"))
}

// Both files, not just the live one: write_log_line rotates at 5 MB, so
// clearing only mindwtr.log left the whole rotated history on disk — the user
// asked for the log to be gone.
fn clear_log_files(log_dir: &Path) -> Result<String, String> {
    let log_path = log_dir.join("mindwtr.log");
    for path in [&log_path, &log_dir.join("mindwtr.log.1")] {
        if path.exists() {
            if let Err(err) = std::fs::remove_file(path) {
                return Err(err.to_string());
            }
        }
    }
    Ok(log_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{clear_log_files, native_log_line};

    #[test]
    fn clearing_the_log_removes_the_rotated_history_too() {
        let temp = tempfile::tempdir().expect("should create temp log dir");
        let log_path = temp.path().join("mindwtr.log");
        let rotated_path = temp.path().join("mindwtr.log.1");
        std::fs::write(&log_path, "live\n").expect("should write live log");
        std::fs::write(&rotated_path, "rotated\n").expect("should write rotated log");

        let cleared = clear_log_files(temp.path()).expect("should clear the log");

        assert_eq!(cleared, log_path.to_string_lossy());
        assert!(!log_path.exists());
        assert!(!rotated_path.exists());
    }

    #[test]
    fn clearing_an_already_empty_log_directory_succeeds() {
        let temp = tempfile::tempdir().expect("should create temp log dir");
        clear_log_files(temp.path()).expect("should clear nothing without erroring");
    }

    #[test]
    fn native_log_line_is_valid_jsonl() {
        let line = native_log_line("Close trace: quoted \"message\"");

        assert!(line.ends_with('\n'));
        let entry: serde_json::Value =
            serde_json::from_str(line.trim_end()).expect("native log line should be JSON");
        assert_eq!(entry["level"], "info");
        assert_eq!(entry["scope"], "app");
        assert_eq!(entry["message"], "Close trace: quoted \"message\"");
        assert_eq!(entry["context"]["source"], "native");
        assert!(entry["ts"].as_str().is_some_and(|value| !value.is_empty()));
    }
}
