use crate::*;

#[tauri::command]
pub(crate) fn log_ai_debug(
    context: String,
    message: String,
    provider: Option<String>,
    model: Option<String>,
    task_id: Option<String>,
) {
    println!(
        "[ai-debug] context={} provider={} model={} task={} message={}",
        context,
        provider.unwrap_or_else(|| "unknown".into()),
        model.unwrap_or_else(|| "unknown".into()),
        task_id.unwrap_or_else(|| "-".into()),
        message
    );
}

#[tauri::command]
pub(crate) fn append_log_line(app: tauri::AppHandle, line: String) -> Result<String, String> {
    let log_dir = get_data_dir(&app).join("logs");
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

#[tauri::command]
pub(crate) fn clear_log_file(app: tauri::AppHandle) -> Result<String, String> {
    let log_path = get_data_dir(&app).join("logs").join("mindwtr.log");
    if log_path.exists() {
        if let Err(err) = std::fs::remove_file(&log_path) {
            return Err(err.to_string());
        }
    }
    Ok(log_path.to_string_lossy().to_string())
}
