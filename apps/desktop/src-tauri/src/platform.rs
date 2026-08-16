use crate::*;

fn strip_file_scheme(raw: &str) -> Result<String, String> {
    if !raw.to_ascii_lowercase().starts_with("file://") {
        return Ok(raw.to_string());
    }

    let without_scheme = &raw[7..];
    if without_scheme.starts_with('/') {
        #[cfg(target_os = "windows")]
        {
            let without_leading_slash = without_scheme.trim_start_matches('/');
            if without_leading_slash.as_bytes().get(1) == Some(&b':') {
                return Ok(without_leading_slash.to_string());
            }
        }
        return Ok(without_scheme.to_string());
    }

    Err("Only local file paths can be opened.".to_string())
}

fn canonical_existing_dir(path: PathBuf) -> Option<PathBuf> {
    path.canonicalize()
        .ok()
        .filter(|candidate| candidate.is_dir())
}

fn configured_obsidian_vault_path(config: &AppConfigToml) -> Option<PathBuf> {
    #[derive(Deserialize, Default)]
    struct VaultPathOnly {
        vault_path: Option<String>,
    }

    let raw = config.obsidian_config.as_ref()?;
    let parsed = serde_json::from_str::<VaultPathOnly>(raw).ok()?;
    let vault_path = parsed.vault_path?.trim().to_string();
    if vault_path.is_empty() {
        return None;
    }
    canonical_existing_dir(PathBuf::from(vault_path))
}

fn allowed_open_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let config = read_config(app);
    let mut roots = vec![
        get_data_dir(app),
        get_data_dir(app).join("attachments"),
        get_data_dir(app).join("audio-captures"),
    ];

    if let Some(sync_path) = config
        .sync_path
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        roots.push(PathBuf::from(sync_path).join("attachments"));
    }

    if let Some(vault_path) = configured_obsidian_vault_path(&config) {
        roots.push(vault_path);
    }

    #[cfg(target_os = "linux")]
    if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        roots.push(PathBuf::from(runtime_dir).join("doc"));
    }

    roots.into_iter().filter_map(canonical_existing_dir).fold(
        Vec::<PathBuf>::new(),
        |mut unique_roots, root| {
            if !unique_roots.iter().any(|existing| existing == &root) {
                unique_roots.push(root);
            }
            unique_roots
        },
    )
}

fn normalize_open_path(raw: &str, managed_attachments_dir: Option<&Path>) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Path is empty".to_string());
    }
    let without_file_scheme = strip_file_scheme(trimmed)?;
    let candidate = PathBuf::from(without_file_scheme);
    if !candidate.is_absolute() {
        return Err("Only absolute local file paths can be opened.".to_string());
    }
    if let Ok(resolved) = candidate.canonicalize() {
        return Ok(resolved);
    }
    // A portable profile travels with the install, so an attachment URI recorded
    // at the previous location is stale even though the file moved along inside
    // the profile's attachments dir. Retry the same file name there before
    // giving up — the recorded path always wins when it still resolves (#1038).
    managed_attachments_dir
        .zip(candidate.file_name())
        .map(|(dir, name)| dir.join(name))
        .and_then(|fallback| fallback.canonicalize().ok())
        // The path is the one clue a user has for repairing a broken
        // reference (moved file, relocated portable profile) — name it (#1001).
        .ok_or_else(|| format!("File does not exist or cannot be accessed: {}", candidate.display()))
}

fn path_is_under_allowed_root(path: &Path, allowed_roots: &[PathBuf]) -> bool {
    allowed_roots
        .iter()
        .any(|root| path == root || path.starts_with(root))
}

// Existing files AND directories are user-openable wherever they live: a user-added
// link may point anywhere on their machine, and opening a folder in the file manager
// is strictly less dangerous than opening a file (which is already allowed and can
// execute). The managed-roots check remains for paths that don't exist locally yet
// (e.g. Flatpak portal documents).
fn path_is_openable(path: &Path, allowed_roots: &[PathBuf]) -> bool {
    path_is_under_allowed_root(path, allowed_roots) || path.is_file() || path.is_dir()
}

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

// Off the UI thread, same reason as get_macos_calendar_events: the shim
// allocates its own EKEventStore per call, so there's no shared-state race.
#[tauri::command(async)]
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

// Off the UI thread: `eventsMatchingPredicate:` is a synchronous EventKit query
// Apple documents as slow, and the shim uses its own EKEventStore per call.
#[tauri::command(async)]
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

#[tauri::command(async)]
pub(crate) fn get_macos_writable_calendars() -> Result<Vec<MacOsCalendarPushTarget>, String> {
    #[cfg(target_os = "macos")]
    {
        let value = parse_macos_eventkit_json(unsafe { mindwtr_macos_writable_calendars_json() })?;
        let parsed = serde_json::from_value::<Vec<MacOsCalendarPushTarget>>(value)
            .map_err(|error| format!("Failed to decode writable EventKit calendars: {error}"))?;
        return Ok(parsed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command(async)]
pub(crate) fn ensure_macos_mindwtr_calendar(
    stored_calendar_id: Option<String>,
) -> Result<Option<MacOsCalendarPushTarget>, String> {
    #[cfg(target_os = "macos")]
    {
        let stored = CString::new(stored_calendar_id.unwrap_or_default())
            .map_err(|error| format!("Invalid stored calendar ID: {error}"))?;
        let value = parse_macos_eventkit_json(unsafe {
            mindwtr_macos_ensure_mindwtr_calendar_json(stored.as_ptr())
        })?;
        if value.is_null() {
            return Ok(None);
        }
        let parsed = serde_json::from_value::<MacOsCalendarPushTarget>(value)
            .map_err(|error| format!("Failed to decode Mindwtr EventKit calendar: {error}"))?;
        return Ok(Some(parsed));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = stored_calendar_id;
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn encode_macos_calendar_event_payload(
    details: &MacOsCalendarEventPayload,
) -> Result<CString, String> {
    let raw = serde_json::to_string(details)
        .map_err(|error| format!("Failed to encode EventKit event payload: {error}"))?;
    CString::new(raw).map_err(|error| format!("Invalid EventKit event payload: {error}"))
}

#[tauri::command(async)]
pub(crate) fn create_macos_calendar_event(
    details: MacOsCalendarEventPayload,
) -> Result<MacOsCalendarEventWriteResult, String> {
    #[cfg(target_os = "macos")]
    {
        let event_json = encode_macos_calendar_event_payload(&details)?;
        let value = parse_macos_eventkit_json(unsafe {
            mindwtr_macos_create_calendar_event_json(event_json.as_ptr())
        })?;
        let parsed = serde_json::from_value::<MacOsCalendarEventWriteResult>(value)
            .map_err(|error| format!("Failed to decode EventKit create result: {error}"))?;
        return Ok(parsed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = details;
        Ok(MacOsCalendarEventWriteResult {
            ok: false,
            event_id: None,
            error: Some("unsupported".to_string()),
        })
    }
}

#[tauri::command(async)]
pub(crate) fn update_macos_calendar_event(
    event_id: String,
    details: MacOsCalendarEventPayload,
) -> Result<MacOsCalendarEventWriteResult, String> {
    #[cfg(target_os = "macos")]
    {
        let event_id = CString::new(event_id.as_str())
            .map_err(|error| format!("Invalid EventKit event ID: {error}"))?;
        let event_json = encode_macos_calendar_event_payload(&details)?;
        let value = parse_macos_eventkit_json(unsafe {
            mindwtr_macos_update_calendar_event_json(event_id.as_ptr(), event_json.as_ptr())
        })?;
        let parsed = serde_json::from_value::<MacOsCalendarEventWriteResult>(value)
            .map_err(|error| format!("Failed to decode EventKit update result: {error}"))?;
        return Ok(parsed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = event_id;
        let _ = details;
        Ok(MacOsCalendarEventWriteResult {
            ok: false,
            event_id: None,
            error: Some("unsupported".to_string()),
        })
    }
}

#[tauri::command(async)]
pub(crate) fn delete_macos_calendar_event(
    event_id: String,
) -> Result<MacOsCalendarEventWriteResult, String> {
    #[cfg(target_os = "macos")]
    {
        let event_id = CString::new(event_id.as_str())
            .map_err(|error| format!("Invalid EventKit event ID: {error}"))?;
        let value = parse_macos_eventkit_json(unsafe {
            mindwtr_macos_delete_calendar_event_json(event_id.as_ptr())
        })?;
        let parsed = serde_json::from_value::<MacOsCalendarEventWriteResult>(value)
            .map_err(|error| format!("Failed to decode EventKit delete result: {error}"))?;
        return Ok(parsed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = event_id;
        Ok(MacOsCalendarEventWriteResult {
            ok: false,
            event_id: None,
            error: Some("unsupported".to_string()),
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
pub(crate) async fn cloudkit_save_attachment_asset(
    record_name: String,
    file_path: String,
    metadata_json: String,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_record_name = CString::new(record_name.as_str())
                .map_err(|e| format!("Invalid attachment record name: {e}"))?;
            let c_file_path = CString::new(file_path.as_str())
                .map_err(|e| format!("Invalid attachment file path: {e}"))?;
            let c_metadata = CString::new(metadata_json.as_str())
                .map_err(|e| format!("Invalid attachment metadata JSON: {e}"))?;
            parse_cloudkit_json(unsafe {
                mindwtr_cloudkit_save_attachment_asset(
                    c_record_name.as_ptr(),
                    c_file_path.as_ptr(),
                    c_metadata.as_ptr(),
                )
            })
        })
        .await
        .map_err(|error| format!("CloudKit save attachment task failed: {error}"))??;
        return Ok(value);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (record_name, file_path, metadata_json);
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_fetch_attachment_asset(
    record_name: String,
    target_path: String,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_record_name = CString::new(record_name.as_str())
                .map_err(|e| format!("Invalid attachment record name: {e}"))?;
            let c_target_path = CString::new(target_path.as_str())
                .map_err(|e| format!("Invalid attachment target path: {e}"))?;
            parse_cloudkit_json(unsafe {
                mindwtr_cloudkit_fetch_attachment_asset(
                    c_record_name.as_ptr(),
                    c_target_path.as_ptr(),
                )
            })
        })
        .await
        .map_err(|error| format!("CloudKit fetch attachment task failed: {error}"))??;
        return Ok(value);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (record_name, target_path);
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

pub(crate) const ATTACHMENT_IMPORT_TOO_LARGE: &str = "file_too_large";

fn sanitize_attachment_file_name(raw: &str) -> Result<&str, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err("Invalid attachment file name.".to_string());
    }
    Ok(trimmed)
}

// Intentionally avoids canonicalize(): exotic mounts (Windows RAM drives, some
// network shares) fail canonicalization even though plain reads work, which is
// exactly the case this import path exists to support.
fn import_attachment_into(
    dest_dir: &Path,
    source: &Path,
    file_name: &str,
    max_bytes: Option<u64>,
) -> Result<(PathBuf, u64), String> {
    if !source.is_absolute() {
        return Err("Only absolute local file paths can be attached.".to_string());
    }
    let metadata = std::fs::metadata(source)
        .map_err(|_| "File does not exist or cannot be accessed.".to_string())?;
    if !metadata.is_file() {
        return Err("Only regular files can be attached.".to_string());
    }
    let size = metadata.len();
    if let Some(max) = max_bytes {
        if size > max {
            return Err(ATTACHMENT_IMPORT_TOO_LARGE.to_string());
        }
    }
    let file_name = sanitize_attachment_file_name(file_name)?;
    std::fs::create_dir_all(dest_dir)
        .map_err(|error| format!("Failed to create attachments directory: {error}"))?;
    let final_path = dest_dir.join(file_name);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let temp_path = dest_dir.join(format!("{file_name}.tmp-{}-{nanos:x}", std::process::id()));
    std::fs::copy(source, &temp_path)
        .map_err(|error| format!("Failed to copy attachment: {error}"))?;
    if let Err(rename_error) = std::fs::rename(&temp_path, &final_path) {
        let copy_result = std::fs::copy(&temp_path, &final_path);
        let _ = std::fs::remove_file(&temp_path);
        copy_result.map_err(|_| format!("Failed to store attachment: {rename_error}"))?;
    }
    Ok((final_path, size))
}

#[derive(Serialize)]
pub(crate) struct ImportedAttachmentFile {
    uri: String,
    size: u64,
}

// Off the UI thread: this copies a user-picked file that may live on a network
// share or removable drive. Concurrent imports are safe — the temp name is
// unique per process and nanosecond, and the final rename is atomic.
#[tauri::command(async)]
pub(crate) fn import_attachment_file(
    app: tauri::AppHandle,
    path: String,
    file_name: String,
    max_bytes: Option<u64>,
) -> Result<ImportedAttachmentFile, String> {
    let source = PathBuf::from(strip_file_scheme(path.trim())?);
    // Matches the webview-side managed dir used by sync downloads, previews,
    // and cleanup; portable mode redirects it into the profile dir (#855).
    let dest_dir = get_data_dir(&app).join("attachments");
    let (final_path, size) = import_attachment_into(&dest_dir, &source, &file_name, max_bytes)?;
    Ok(ImportedAttachmentFile {
        uri: final_path.to_string_lossy().into_owned(),
        size,
    })
}

// The directory the webview must use for managed app files (attachments, logs,
// audio captures, speech models). Portable mode points it into the profile dir.
#[tauri::command]
pub(crate) fn get_managed_data_dir(app: tauri::AppHandle) -> String {
    get_data_dir(&app).to_string_lossy().into_owned()
}

fn legacy_webview_data_root() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("mindwtr"))
}

// A standard (installed) copy of Mindwtr on the same machine stores its data
// under the OS data dir; its attachment files must never be moved away by a
// portable copy that references the same paths.
fn standard_install_present(legacy_root: &Path) -> bool {
    legacy_root.join(DATA_FILE_NAME).exists() || legacy_root.join(DB_FILE_NAME).exists()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableAttachmentMigration {
    is_portable: bool,
    legacy_attachments_dir: String,
    managed_attachments_dir: String,
    migrated_file_names: Vec<String>,
}

// One-time, idempotent re-home of attachment files a portable install wrote to
// the OS data dir before portable mode covered webview-managed files (#855).
// Only the requested file names are touched, sources must live inside the
// legacy attachments dir, and files are copied (not moved) when a standard
// install shares the machine. Runs off the UI thread because it copies
// attachment files at startup, often from a USB profile dir.
#[tauri::command(async)]
pub(crate) fn migrate_portable_attachments(
    app: tauri::AppHandle,
    file_names: Vec<String>,
) -> Result<PortableAttachmentMigration, String> {
    let managed_dir = get_data_dir(&app).join("attachments");
    let legacy_root = legacy_webview_data_root();
    let legacy_dir = legacy_root
        .as_ref()
        .map(|root| root.join("attachments"))
        .unwrap_or_default();
    let mut result = PortableAttachmentMigration {
        is_portable: crate::storage::is_portable_mode(),
        legacy_attachments_dir: legacy_dir.to_string_lossy().into_owned(),
        managed_attachments_dir: managed_dir.to_string_lossy().into_owned(),
        migrated_file_names: Vec::new(),
    };
    if !result.is_portable || file_names.is_empty() {
        return Ok(result);
    }
    let Some(legacy_root) = legacy_root else {
        return Ok(result);
    };
    if legacy_dir == managed_dir || !legacy_dir.is_dir() {
        return Ok(result);
    }
    let keep_legacy_copy = standard_install_present(&legacy_root);
    for file_name in file_names {
        // Reject anything that could escape the legacy attachments dir.
        if file_name.is_empty()
            || file_name.contains('/')
            || file_name.contains('\\')
            || file_name == "."
            || file_name == ".."
        {
            continue;
        }
        let source = legacy_dir.join(&file_name);
        if !source.is_file() {
            continue;
        }
        let target = managed_dir.join(&file_name);
        if target.exists() {
            result.migrated_file_names.push(file_name);
            continue;
        }
        if let Err(error) = fs::create_dir_all(&managed_dir) {
            return Err(format!("Failed to create attachments directory: {error}"));
        }
        let moved = if keep_legacy_copy {
            fs::copy(&source, &target).map(|_| ())
        } else {
            fs::rename(&source, &target).or_else(|_| {
                // Profile dir may sit on another volume (USB stick).
                fs::copy(&source, &target).map(|_| {
                    let _ = fs::remove_file(&source);
                })
            })
        };
        match moved {
            Ok(()) => result.migrated_file_names.push(file_name),
            Err(error) => {
                log::warn!("Failed to migrate portable attachment {file_name}: {error}");
            }
        }
    }
    Ok(result)
}

// Stateless: canonicalizes the path and spawns the OS file-open shell
// command, no shared state to race (B1).
#[tauri::command(async)]
pub(crate) fn open_path(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let managed_attachments_dir = get_data_dir(&app).join("attachments");
    let normalized = normalize_open_path(&path, Some(&managed_attachments_dir))?;
    let allowed_roots = allowed_open_roots(&app);
    if !path_is_openable(&normalized, &allowed_roots) {
        return Err("Path does not exist or cannot be opened.".to_string());
    }
    open::that(normalized).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_open_path_rejects_urls_and_relative_paths() {
        assert!(normalize_open_path("https://example.com/file.txt", None).is_err());
        assert!(normalize_open_path("../notes.txt", None).is_err());
    }

    #[test]
    fn normalize_open_path_falls_back_to_the_current_managed_attachments_dir() {
        // #1038: a portable profile that moved leaves every stored URI pointing
        // at the old location, though the file travelled inside attachments/.
        let dir = tempfile::tempdir().expect("tempdir");
        let managed_dir = dir.path().join("new-profile").join("attachments");
        std::fs::create_dir_all(&managed_dir).expect("create managed dir");
        let managed_file = managed_dir.join("id-1.txt");
        std::fs::write(&managed_file, b"attachment").expect("write attachment");
        let stale = dir
            .path()
            .join("old-profile")
            .join("attachments")
            .join("id-1.txt");

        let resolved = normalize_open_path(&stale.to_string_lossy(), Some(&managed_dir))
            .expect("stale portable path resolves against the current profile");
        assert_eq!(resolved, managed_file.canonicalize().expect("canonicalize"));

        // A path with no counterpart in the managed dir still fails, and names
        // the recorded path so the user can repair the reference (#1001).
        let missing = dir.path().join("elsewhere").join("report.pdf");
        let error = normalize_open_path(&missing.to_string_lossy(), Some(&managed_dir))
            .expect_err("unrelated missing file must not resolve");
        assert!(error.contains(&missing.display().to_string()), "{error}");
    }

    #[test]
    fn import_attachment_into_copies_file_and_keeps_original() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("original.txt");
        std::fs::write(&source, b"hello attachment").expect("write source");
        let dest_dir = dir.path().join("managed");

        let (copied, size) =
            import_attachment_into(&dest_dir, &source, "id-1.txt", Some(1024)).expect("import");

        assert_eq!(size, 16);
        assert_eq!(copied, dest_dir.join("id-1.txt"));
        assert_eq!(
            std::fs::read(&copied).expect("read copy"),
            b"hello attachment"
        );
        assert!(source.exists(), "original must stay untouched");
        let leftovers: Vec<_> = std::fs::read_dir(&dest_dir)
            .expect("read dest dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "no temp files may remain");
    }

    #[test]
    fn import_attachment_into_rejects_oversized_missing_and_bad_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("big.bin");
        std::fs::write(&source, vec![0u8; 32]).expect("write source");
        let dest_dir = dir.path().join("managed");

        let too_large = import_attachment_into(&dest_dir, &source, "id.bin", Some(16));
        assert_eq!(too_large.unwrap_err(), ATTACHMENT_IMPORT_TOO_LARGE);

        let missing =
            import_attachment_into(&dest_dir, &dir.path().join("nope.bin"), "id.bin", None);
        assert!(missing.is_err());

        let relative = import_attachment_into(&dest_dir, Path::new("relative.bin"), "id.bin", None);
        assert!(relative.is_err());

        let traversal = import_attachment_into(&dest_dir, &source, "../escape.bin", None);
        assert!(traversal.is_err());
    }

    #[test]
    fn path_is_under_allowed_root_respects_boundaries() {
        let root = PathBuf::from("/tmp/mindwtr");
        assert!(path_is_under_allowed_root(
            Path::new("/tmp/mindwtr/attachments/a.pdf"),
            &[root.clone()]
        ));
        assert!(!path_is_under_allowed_root(
            Path::new("/tmp/mindwtr-other/a.pdf"),
            &[root]
        ));
    }

    #[test]
    fn path_is_under_allowed_root_allows_flatpak_document_portal_paths() {
        let portal_root = PathBuf::from("/run/user/1000/doc");
        assert!(path_is_under_allowed_root(
            Path::new("/run/user/1000/doc/abc123/notes.pdf"),
            &[portal_root]
        ));
    }

    #[test]
    fn path_is_openable_allows_existing_user_selected_files() {
        let temp = tempfile::tempdir().expect("should create temp dir");
        let attachment_path = temp.path().join("notes.md");
        fs::write(&attachment_path, "notes").expect("should write attachment");

        assert!(path_is_openable(&attachment_path, &[]));
    }

    #[test]
    fn path_is_openable_allows_existing_user_linked_directories() {
        let temp = tempfile::tempdir().expect("should create temp dir");

        assert!(path_is_openable(temp.path(), &[]));
    }

    #[test]
    fn path_is_openable_rejects_missing_paths() {
        let temp = tempfile::tempdir().expect("should create temp dir");

        assert!(!path_is_openable(&temp.path().join("does-not-exist"), &[]));
    }
}

/// Accessory removes the Dock icon, the Cmd+Tab entry and the app's menu bar,
/// so it is only ever correct while the main window is actually hidden in the
/// tray. Every caller therefore sits on a hide or a show path, never on a
/// settings change. No-op off macOS, so call sites stay platform-agnostic.
///
/// Applying a policy does not activate the app: a caller switching back to
/// Regular for a window it is about to show must still focus that window, or
/// the menu bar keeps belonging to the previously frontmost app.
pub(crate) fn apply_macos_activation_policy(
    app: &tauri::AppHandle,
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
        let _ = (app, accessory);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn set_macos_activation_policy(
    app: tauri::AppHandle,
    accessory: bool,
) -> Result<(), String> {
    apply_macos_activation_policy(&app, accessory)
}
