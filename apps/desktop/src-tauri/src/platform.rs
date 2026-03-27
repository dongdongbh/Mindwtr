use crate::*;

#[cfg(target_os = "macos")]
fn parse_macos_eventkit_json(raw: *mut c_char) -> Result<Value, String> {
    if raw.is_null() {
        return Err("EventKit bridge returned null output".to_string());
    }
    // SAFETY: We have verified `raw` is non-null. The Objective-C bridge allocates
    // via `strdup()` so the pointer is valid until we free it. We copy the string
    // immediately and then free the original to avoid use-after-free.
    let text = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    unsafe { mindwtr_macos_calendar_free_string(raw) };
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Failed to parse EventKit bridge output: {error}"))
}

#[tauri::command]
pub(crate) fn get_macos_calendar_permission_status() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let value =
            parse_macos_eventkit_json(unsafe { mindwtr_macos_calendar_permission_status_json() })?;
        let status = value
            .get("status")
            .and_then(|item| item.as_str())
            .unwrap_or("denied");
        return Ok(status.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("unsupported".to_string())
    }
}

#[tauri::command]
pub(crate) async fn request_macos_calendar_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(|| {
            parse_macos_eventkit_json(unsafe { mindwtr_macos_calendar_request_permission_json() })
        })
        .await
        .map_err(|error| format!("EventKit permission request task failed: {error}"))??;
        let status = value
            .get("status")
            .and_then(|item| item.as_str())
            .unwrap_or("denied");
        return Ok(status.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("unsupported".to_string())
    }
}

#[tauri::command]
pub(crate) fn get_macos_calendar_events(
    range_start: String,
    range_end: String,
) -> Result<MacOsCalendarReadResult, String> {
    #[cfg(target_os = "macos")]
    {
        let start = CString::new(range_start.as_str())
            .map_err(|error| format!("Invalid calendar range start: {error}"))?;
        let end = CString::new(range_end.as_str())
            .map_err(|error| format!("Invalid calendar range end: {error}"))?;
        let value = parse_macos_eventkit_json(unsafe {
            mindwtr_macos_calendar_events_json(start.as_ptr(), end.as_ptr())
        })?;
        let parsed = serde_json::from_value::<MacOsCalendarReadResult>(value)
            .map_err(|error| format!("Failed to decode EventKit payload: {error}"))?;
        return Ok(parsed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = range_start;
        let _ = range_end;
        Ok(MacOsCalendarReadResult {
            permission: "unsupported".to_string(),
            calendars: Vec::new(),
            events: Vec::new(),
        })
    }
}

#[cfg(target_os = "macos")]
fn parse_cloudkit_json(raw: *mut c_char) -> Result<Value, String> {
    if raw.is_null() {
        return Err("CloudKit bridge returned null output".to_string());
    }
    let text = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    unsafe { mindwtr_cloudkit_free_string(raw) };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Failed to parse CloudKit bridge output: {error}"))?;
    if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
        return Err(format!("CloudKit error: {err}"));
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn cloudkit_account_status() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(|| {
            parse_cloudkit_json(unsafe { mindwtr_cloudkit_account_status() })
        })
        .await
        .map_err(|error| format!("CloudKit account status task failed: {error}"))??;
        let status = value
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown");
        return Ok(status.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("unsupported".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_ensure_zone() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            parse_cloudkit_json(unsafe { mindwtr_cloudkit_ensure_zone() })
        })
        .await
        .map_err(|error| format!("CloudKit ensure zone task failed: {error}"))??;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_ensure_subscription() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            parse_cloudkit_json(unsafe { mindwtr_cloudkit_ensure_subscription() })
        })
        .await
        .map_err(|error| format!("CloudKit ensure subscription task failed: {error}"))??;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_fetch_all_records(record_type: String) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_type = CString::new(record_type.as_str())
                .map_err(|e| format!("Invalid record type: {e}"))?;
            parse_cloudkit_json(unsafe { mindwtr_cloudkit_fetch_all_records(c_type.as_ptr()) })
        })
        .await
        .map_err(|error| format!("CloudKit fetch all records task failed: {error}"))??;
        return Ok(value);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = record_type;
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_fetch_changes(change_token: Option<String>) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_token = change_token
                .as_deref()
                .map(|s| CString::new(s).ok())
                .flatten();
            let ptr = c_token.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());
            parse_cloudkit_json(unsafe { mindwtr_cloudkit_fetch_changes(ptr) })
        })
        .await
        .map_err(|error| format!("CloudKit fetch changes task failed: {error}"))??;
        return Ok(value);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = change_token;
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_save_records(
    record_type: String,
    records_json: String,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_type = CString::new(record_type.as_str())
                .map_err(|e| format!("Invalid record type: {e}"))?;
            let c_json = CString::new(records_json.as_str())
                .map_err(|e| format!("Invalid records JSON: {e}"))?;
            parse_cloudkit_json(unsafe {
                mindwtr_cloudkit_save_records(c_type.as_ptr(), c_json.as_ptr())
            })
        })
        .await
        .map_err(|error| format!("CloudKit save records task failed: {error}"))??;
        return Ok(value);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (record_type, records_json);
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_delete_records(
    record_type: String,
    record_ids: Vec<String>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_type = CString::new(record_type.as_str())
                .map_err(|e| format!("Invalid record type: {e}"))?;
            let ids_json = serde_json::to_string(&record_ids)
                .map_err(|e| format!("Failed to serialize record IDs: {e}"))?;
            let c_ids = CString::new(ids_json.as_str())
                .map_err(|e| format!("Invalid record IDs JSON: {e}"))?;
            parse_cloudkit_json(unsafe {
                mindwtr_cloudkit_delete_records(c_type.as_ptr(), c_ids.as_ptr())
            })
        })
        .await
        .map_err(|error| format!("CloudKit delete records task failed: {error}"))??;
        let _ = value;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (record_type, record_ids);
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) fn cloudkit_consume_pending_remote_change() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let had_change = unsafe { mindwtr_cloudkit_consume_pending_remote_change() };
        return Ok(had_change != 0);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) fn cloudkit_register_for_notifications() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        unsafe { mindwtr_cloudkit_register_for_remote_notifications() };
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) fn open_path(path: String) -> Result<bool, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is empty".to_string());
    }
    let normalized = if trimmed.starts_with("file://") {
        trimmed.trim_start_matches("file://")
    } else {
        trimmed
    };
    open::that(normalized).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn set_macos_activation_policy(
    app: tauri::AppHandle,
    accessory: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let policy = if accessory {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        app.set_activation_policy(policy)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, accessory);
    }
    Ok(())
}
