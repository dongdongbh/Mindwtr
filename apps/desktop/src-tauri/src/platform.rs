use crate::*;
use std::path::Component;

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

// #1245 moved an installed Windows/macOS profile's managed folders from
// `<root>/` down into `<root>/data/`. Only these two hold files whose absolute
// path was recorded in an attachment `uri`; `quick-add-images` did not move, so
// old pasted-image paths must keep resolving exactly where they are.
const RELOCATED_MANAGED_DIR_NAMES: &[&str] = &["attachments", "audio-captures"];

/// Map a path recorded at the flat profile root onto the same file under the
/// current managed data dir. Unlike the relocated portable profile of #1038 the
/// stale path sits inside the OS data dir and its file name need not be the
/// attachment id (audio captures are named after their timestamp), so the
/// id-based fallback never reaches it. Every remaining component must be a plain
/// name — a traversal segment would leave the managed data dir, so it is refused.
fn rehomed_managed_path(candidate: &Path, managed_attachments_dir: &Path) -> Option<PathBuf> {
    let managed_data_dir = managed_attachments_dir.parent()?;
    let rest = candidate.strip_prefix(managed_data_dir.parent()?).ok()?;
    let mut components = rest.components();
    let dir_name = match components.next()? {
        Component::Normal(name) => name.to_str()?,
        _ => return None,
    };
    if !RELOCATED_MANAGED_DIR_NAMES.contains(&dir_name) {
        return None;
    }
    let mut rehomed = managed_data_dir.join(dir_name);
    let mut has_tail = false;
    for component in components {
        match component {
            Component::Normal(name) => rehomed.push(name),
            _ => return None,
        }
        has_tail = true;
    }
    (has_tail && rehomed != candidate).then_some(rehomed)
}

fn normalize_open_path(
    raw: &str,
    managed_attachments_dir: Option<&Path>,
    attachment_id: Option<&str>,
) -> Result<PathBuf, String> {
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
    if let Some(resolved) = managed_attachments_dir
        .and_then(|dir| rehomed_managed_path(&candidate, dir))
        .and_then(|rehomed| rehomed.canonicalize().ok())
    {
        return Ok(resolved);
    }
    let file_name_matches_attachment = candidate.file_name().is_some_and(|name| {
        attachment_id.is_some_and(|attachment_id| {
            let name = name.to_string_lossy();
            name == attachment_id
                || name
                    .strip_prefix(attachment_id)
                    .is_some_and(|suffix| suffix.starts_with('.'))
        })
    });
    file_name_matches_attachment
        .then_some(())
        .and(managed_attachments_dir)
        .zip(candidate.file_name())
        .map(|(dir, name)| dir.join(name))
        .and_then(|fallback| fallback.canonicalize().ok())
        // The path is the one clue a user has for repairing a broken
        // reference (moved file, relocated portable profile) — name it (#1001).
        .ok_or_else(|| {
            format!(
                "File does not exist or cannot be accessed: {}",
                candidate.display()
            )
        })
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

#[cfg(any(target_os = "macos", test))]
const CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE: &str = "ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudKitAttachmentCommandError {
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    message: String,
}

impl CloudKitAttachmentCommandError {
    fn transport(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    #[cfg(any(target_os = "macos", test))]
    fn bridge(message: &str, code: Option<&str>) -> Self {
        Self {
            code: (code == Some(CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE))
                .then(|| CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE.to_string()),
            message: format!("CloudKit error: {message}"),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn parse_cloudkit_value(value: Value) -> Result<Value, String> {
    if let Some(err) = value.get("error").and_then(|error| error.as_str()) {
        return Err(format!("CloudKit error: {err}"));
    }
    Ok(value)
}

#[cfg(any(target_os = "macos", test))]
fn parse_cloudkit_attachment_value(value: Value) -> Result<Value, CloudKitAttachmentCommandError> {
    if let Some(err) = value.get("error").and_then(|error| error.as_str()) {
        let code = value.get("errorCode").and_then(|code| code.as_str());
        return Err(CloudKitAttachmentCommandError::bridge(err, code));
    }
    Ok(value)
}

#[cfg(target_os = "macos")]
fn decode_cloudkit_json(raw: *mut c_char) -> Result<Value, String> {
    if raw.is_null() {
        return Err("CloudKit bridge returned null output".to_string());
    }
    let text = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    unsafe { mindwtr_cloudkit_free_string(raw) };
    serde_json::from_str(&text)
        .map_err(|error| format!("Failed to parse CloudKit bridge output: {error}"))
}

#[cfg(target_os = "macos")]
fn parse_cloudkit_json(raw: *mut c_char) -> Result<Value, String> {
    parse_cloudkit_value(decode_cloudkit_json(raw)?)
}

#[cfg(target_os = "macos")]
fn parse_cloudkit_attachment_json(
    raw: *mut c_char,
) -> Result<Value, CloudKitAttachmentCommandError> {
    let value = decode_cloudkit_json(raw).map_err(CloudKitAttachmentCommandError::transport)?;
    parse_cloudkit_attachment_value(value)
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
    assume_new: Option<bool>,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_type = CString::new(record_type.as_str())
                .map_err(|e| format!("Invalid record type: {e}"))?;
            let c_json = CString::new(records_json.as_str())
                .map_err(|e| format!("Invalid records JSON: {e}"))?;
            parse_cloudkit_json(unsafe {
                mindwtr_cloudkit_save_records(c_type.as_ptr(), c_json.as_ptr(), assume_new.unwrap_or(false))
            })
        })
        .await
        .map_err(|error| format!("CloudKit save records task failed: {error}"))??;
        return Ok(value);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (record_type, records_json, assume_new);
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
) -> Result<Value, CloudKitAttachmentCommandError> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_record_name = CString::new(record_name.as_str()).map_err(|e| {
                CloudKitAttachmentCommandError::transport(format!(
                    "Invalid attachment record name: {e}"
                ))
            })?;
            let c_target_path = CString::new(target_path.as_str()).map_err(|e| {
                CloudKitAttachmentCommandError::transport(format!(
                    "Invalid attachment target path: {e}"
                ))
            })?;
            parse_cloudkit_attachment_json(unsafe {
                mindwtr_cloudkit_fetch_attachment_asset(
                    c_record_name.as_ptr(),
                    c_target_path.as_ptr(),
                )
            })
        })
        .await
        .map_err(|error| {
            CloudKitAttachmentCommandError::transport(format!(
                "CloudKit fetch attachment task failed: {error}"
            ))
        })??;
        return Ok(value);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (record_name, target_path);
        Err(CloudKitAttachmentCommandError::transport(
            "CloudKit is not available on this platform",
        ))
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

// Device-level managed files (logs, speech models) shared by every workspace
// (#1473). The same folder as get_managed_data_dir in the default workspace.
#[tauri::command(async)]
pub(crate) fn get_device_managed_data_dir(app: tauri::AppHandle) -> String {
    crate::storage::get_device_data_dir(&app)
        .to_string_lossy()
        .into_owned()
}

fn legacy_webview_data_root() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("mindwtr"))
}

// A standard (installed) copy of Mindwtr on the same machine stores its data
// under the OS data dir; its attachment files must never be moved away by a
// portable copy that references the same paths. Since #1245 a standard install
// on Windows and macOS keeps those files one level down in `data/`, so both
// layouts count — missing the new one would turn a copy back into a move and
// take the installed app's attachments with it (#936, #1119).
fn standard_install_present(legacy_root: &Path) -> bool {
    use crate::storage_layout::{CONFIG_DIR_NAME, DATA_DIR_NAME, DATA_JSON_BACKUP_FILE_NAME};

    let data_subfolder = legacy_root.join(DATA_DIR_NAME);
    let data_present = [legacy_root, &data_subfolder].iter().any(|root| {
        root.join(DATA_FILE_NAME).exists()
            || root.join(DB_FILE_NAME).exists()
            // An interrupted replacement can leave only the recovery copy.
            || root.join(DATA_JSON_BACKUP_FILE_NAME).exists()
    });
    data_present
        || legacy_root.join(CONFIG_FILE_NAME).exists()
        || legacy_root
            .join(CONFIG_DIR_NAME)
            .join(CONFIG_FILE_NAME)
            .exists()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableAttachmentMigration {
    is_portable: bool,
    legacy_attachments_dir: String,
    managed_attachments_dir: String,
    migrated_file_names: Vec<String>,
}

// Where a pre-#855 attachment file can still be sitting in the OS data dir.
// Since #1245 an installed build on the same machine keeps those files one
// level down in `data/`, so both layouts count — the same rule
// `standard_install_present` already follows. The dir REPORTED to the webview
// stays the flat one: that is what the stored URIs name.
fn legacy_portable_attachment_dirs(legacy_root: &Path) -> Vec<PathBuf> {
    use crate::storage_layout::DATA_DIR_NAME;

    [legacy_root.to_path_buf(), legacy_root.join(DATA_DIR_NAME)]
        .into_iter()
        .map(|root| root.join("attachments"))
        .filter(|dir| dir.is_dir())
        .collect()
}

fn migrate_portable_attachment_files(
    source_dirs: &[PathBuf],
    managed_dir: &Path,
    keep_legacy_copy: bool,
    file_names: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut migrated = Vec::new();
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
        let Some(source) = source_dirs
            .iter()
            .map(|dir| dir.join(&file_name))
            .find(|candidate| candidate.is_file())
        else {
            continue;
        };
        let target = managed_dir.join(&file_name);
        if target.exists() {
            migrated.push(file_name);
            continue;
        }
        if let Err(error) = fs::create_dir_all(managed_dir) {
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
            Ok(()) => migrated.push(file_name),
            Err(error) => {
                log::warn!("Failed to migrate portable attachment {file_name}: {error}");
            }
        }
    }
    Ok(migrated)
}

// One-time, idempotent re-home of attachment files a portable install wrote to
// the OS data dir before portable mode covered webview-managed files (#855).
// Only the requested file names are touched, sources must live inside a legacy
// attachments dir, and files are copied (not moved) when a standard install
// shares the machine. Runs off the UI thread because it copies attachment files
// at startup, often from a USB profile dir.
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
    // The legacy files belong to the default workspace's tasks; another
    // workspace never adopts them (#1473).
    if !result.is_portable
        || file_names.is_empty()
        || crate::workspaces::active_workspace_id().is_some()
    {
        return Ok(result);
    }
    let Some(legacy_root) = legacy_root else {
        return Ok(result);
    };
    let source_dirs: Vec<PathBuf> = legacy_portable_attachment_dirs(&legacy_root)
        .into_iter()
        .filter(|dir| *dir != managed_dir)
        .collect();
    if source_dirs.is_empty() {
        return Ok(result);
    }
    let keep_legacy_copy = standard_install_present(&legacy_root);
    result.migrated_file_names = migrate_portable_attachment_files(
        &source_dirs,
        &managed_dir,
        keep_legacy_copy,
        file_names,
    )?;
    Ok(result)
}

#[cfg(any(target_os = "macos", test))]
fn link_folder_bookmark_for(raw: Option<&str>, attachment_id: &str) -> Option<String> {
    let map = serde_json::from_str::<Map<String, Value>>(raw?).ok()?;
    map.get(attachment_id)?.as_str().map(str::to_string)
}

// An unreadable map is replaced: it only caches access the user can grant
// again by re-linking the folder.
#[cfg(any(target_os = "macos", test))]
fn with_link_folder_bookmark(raw: Option<&str>, attachment_id: &str, bookmark: String) -> String {
    let mut map = raw
        .and_then(|raw| serde_json::from_str::<Map<String, Value>>(raw).ok())
        .unwrap_or_default();
    map.insert(attachment_id.to_string(), Value::String(bookmark));
    Value::Object(map).to_string()
}

// "Link folder…" on the sandboxed App Store build: the folder the user just
// picked is reachable only for this launch, so keep a security-scoped
// bookmark for it in the device-local config. Other builds open the stored
// path as is and keep nothing.
// ponytail: entries are never pruned when a link is removed; each is a few
// hundred bytes, prune on attachment delete if the config ever grows large.
#[tauri::command(async)]
pub(crate) fn remember_link_folder_access(
    app: tauri::AppHandle,
    attachment_id: String,
    path: String,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if !crate::install::is_mac_app_store_build() {
            return Ok(false);
        }
        let c_path = CString::new(path).map_err(|e| e.to_string())?;
        let raw = unsafe { mindwtr_macos_create_security_bookmark(c_path.as_ptr()) };
        if raw.is_null() {
            log::warn!("Linked folder bookmark could not be created extra.releaseCheck=v1.3.4/link-folder-bookmark outcome=create-failed");
            return Ok(false);
        }
        let bookmark = unsafe { CStr::from_ptr(raw) }.to_string_lossy().to_string();
        unsafe { mindwtr_macos_free_bookmark_string(raw) };
        let _config_guard = lock_config_read_modify_write()?;
        let mut config = read_config(&app);
        config.link_folder_bookmarks = Some(with_link_folder_bookmark(
            config.link_folder_bookmarks.as_deref(),
            &attachment_id,
            bookmark,
        ));
        write_config_files(&get_config_path(&app), &get_secrets_path(&app), &config)?;
        log::info!("Linked folder bookmark saved extra.releaseCheck=v1.3.4/link-folder-bookmark outcome=saved");
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, attachment_id, path);
        Ok(false)
    }
}

// Ok(false) = no usable bookmark on this device; the caller takes the normal
// open path, which the sandbox may refuse with the usual error.
#[cfg(target_os = "macos")]
fn open_through_link_folder_bookmark(
    app: &tauri::AppHandle,
    path: &str,
    attachment_id: Option<&str>,
) -> Result<bool, String> {
    let Some(attachment_id) = attachment_id else {
        return Ok(false);
    };
    if !crate::install::is_mac_app_store_build() {
        return Ok(false);
    }
    let config = read_config(app);
    let Some(bookmark) =
        link_folder_bookmark_for(config.link_folder_bookmarks.as_deref(), attachment_id)
    else {
        return Ok(false);
    };
    let expected = strip_file_scheme(path.trim())?;
    let (Ok(c_bookmark), Ok(c_expected)) = (CString::new(bookmark), CString::new(expected)) else {
        return Ok(false);
    };
    let outcome =
        unsafe { mindwtr_macos_open_security_bookmark(c_bookmark.as_ptr(), c_expected.as_ptr()) };
    let label = match outcome {
        1 => "opened",
        0 => "fallback",
        _ => "open-failed",
    };
    log::info!("Linked folder opened through its bookmark extra.releaseCheck=v1.3.4/link-folder-bookmark outcome={label}");
    match outcome {
        1 => Ok(true),
        0 => Ok(false),
        _ => Err("Path does not exist or cannot be opened.".to_string()),
    }
}

// Stateless: canonicalizes the path and spawns the OS file-open shell
// command, no shared state to race (B1).
#[tauri::command(async)]
pub(crate) fn open_path(
    app: tauri::AppHandle,
    path: String,
    attachment_id: Option<String>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    if open_through_link_folder_bookmark(&app, &path, attachment_id.as_deref())? {
        return Ok(true);
    }
    let managed_attachments_dir = get_data_dir(&app).join("attachments");
    let normalized = normalize_open_path(
        &path,
        Some(&managed_attachments_dir),
        attachment_id.as_deref(),
    )?;
    let allowed_roots = allowed_open_roots(&app);
    if !path_is_openable(&normalized, &allowed_roots) {
        return Err("Path does not exist or cannot be opened.".to_string());
    }
    // Detached: waiting on the handler would block this command for as long as
    // the viewer or browser stays open.
    open::that_detached(normalized).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Whatever this misses, a portable launch renames the installed app's
    // attachments away instead of copying them (#936, #1119). Every file an
    // installed profile can be left holding counts as evidence.
    #[test]
    fn a_standard_install_is_recognized_from_every_profile_marker() {
        use crate::storage_layout::{CONFIG_DIR_NAME, DATA_DIR_NAME, DATA_JSON_BACKUP_FILE_NAME};

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        assert!(!standard_install_present(root), "empty OS data dir");

        let data = root.join(DATA_DIR_NAME);
        let config = root.join(CONFIG_DIR_NAME);
        std::fs::create_dir_all(&data).expect("data dir");
        std::fs::create_dir_all(&config).expect("config dir");
        // Still not evidence: the two folders alone say nothing.
        assert!(!standard_install_present(root));

        let markers = [
            // The flat layout older versions wrote.
            root.join(DB_FILE_NAME),
            root.join(DATA_FILE_NAME),
            root.join(CONFIG_FILE_NAME),
            // An interrupted Windows replacement can leave only this.
            root.join(DATA_JSON_BACKUP_FILE_NAME),
            // The subfolder layout installed builds use since #1245.
            data.join(DB_FILE_NAME),
            data.join(DATA_FILE_NAME),
            data.join(DATA_JSON_BACKUP_FILE_NAME),
            config.join(CONFIG_FILE_NAME),
        ];
        for marker in markers {
            std::fs::write(&marker, "x").expect("marker");
            assert!(
                standard_install_present(root),
                "{} must count as an installed profile",
                marker.display()
            );
            std::fs::remove_file(&marker).expect("remove marker");
        }
        assert!(!standard_install_present(root));
    }

    // #1245: once an installed build on the same machine moved its managed
    // folders into `data/`, a portable copy that still references pre-#855
    // files there found nothing to copy. Both layouts are searched — and an
    // installed profile's files are still COPIED, never moved (#936, #1119).
    #[test]
    fn portable_migration_finds_legacy_files_in_both_layouts() {
        use crate::storage_layout::DATA_DIR_NAME;

        let temp = tempfile::tempdir().expect("temp dir");
        let legacy_root = temp.path().join("os-data").join("mindwtr");
        let flat_dir = legacy_root.join("attachments");
        let moved_dir = legacy_root.join(DATA_DIR_NAME).join("attachments");
        let managed_dir = temp.path().join("portable").join("data").join("attachments");
        std::fs::create_dir_all(&flat_dir).expect("flat dir");
        std::fs::create_dir_all(&moved_dir).expect("moved dir");
        std::fs::write(flat_dir.join("flat.pdf"), b"flat").expect("flat file");
        std::fs::write(moved_dir.join("moved.pdf"), b"moved").expect("moved file");

        let source_dirs = legacy_portable_attachment_dirs(&legacy_root);
        assert_eq!(source_dirs, vec![flat_dir.clone(), moved_dir.clone()]);

        let migrated = migrate_portable_attachment_files(
            &source_dirs,
            &managed_dir,
            true,
            vec![
                "flat.pdf".to_string(),
                "moved.pdf".to_string(),
                "../escape.pdf".to_string(),
            ],
        )
        .expect("migration runs");

        assert_eq!(migrated, vec!["flat.pdf".to_string(), "moved.pdf".to_string()]);
        assert_eq!(
            std::fs::read(managed_dir.join("moved.pdf")).expect("copy"),
            b"moved"
        );
        // The installed app still references both originals.
        assert!(flat_dir.join("flat.pdf").is_file());
        assert!(moved_dir.join("moved.pdf").is_file());
        assert!(!managed_dir.join("escape.pdf").exists());
    }

    #[test]
    fn portable_migration_moves_files_when_no_installed_profile_shares_them() {
        let temp = tempfile::tempdir().expect("temp dir");
        let legacy_dir = temp.path().join("os-data").join("mindwtr").join("attachments");
        let managed_dir = temp.path().join("portable").join("data").join("attachments");
        std::fs::create_dir_all(&legacy_dir).expect("legacy dir");
        std::fs::write(legacy_dir.join("a1.pdf"), b"bytes").expect("legacy file");

        let migrated = migrate_portable_attachment_files(
            std::slice::from_ref(&legacy_dir),
            &managed_dir,
            false,
            vec!["a1.pdf".to_string()],
        )
        .expect("migration runs");

        assert_eq!(migrated, vec!["a1.pdf".to_string()]);
        assert!(managed_dir.join("a1.pdf").is_file());
        assert!(!legacy_dir.join("a1.pdf").exists());
    }

    #[test]
    fn cloudkit_attachment_parser_preserves_only_the_terminal_missing_code() {
        for reason in ["attachment-record-not-found", "attachment-asset-missing"] {
            let error = parse_cloudkit_attachment_value(serde_json::json!({
                "error": reason,
                "errorCode": CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE,
            }))
            .expect_err("terminal attachment absence must reject");

            assert_eq!(
                error,
                CloudKitAttachmentCommandError {
                    code: Some(CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE.to_string()),
                    message: format!("CloudKit error: {reason}"),
                }
            );
            assert_eq!(
                serde_json::to_value(&error).expect("serialize command error"),
                serde_json::json!({
                    "code": CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE,
                    "message": format!("CloudKit error: {reason}"),
                })
            );
        }

        let transient = parse_cloudkit_attachment_value(serde_json::json!({
            "error": "network-unavailable",
            "errorCode": 4,
        }))
        .expect_err("transient CloudKit errors still reject");
        assert_eq!(
            transient,
            CloudKitAttachmentCommandError {
                code: None,
                message: "CloudKit error: network-unavailable".to_string(),
            }
        );
        assert_eq!(
            serde_json::to_value(&transient).expect("serialize transient command error"),
            serde_json::json!({
                "message": "CloudKit error: network-unavailable",
            })
        );
    }

    #[test]
    fn normalize_open_path_rejects_urls_and_relative_paths() {
        assert!(normalize_open_path("https://example.com/file.txt", None, None).is_err());
        assert!(normalize_open_path("../notes.txt", None, None).is_err());
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

        let resolved =
            normalize_open_path(&stale.to_string_lossy(), Some(&managed_dir), Some("id-1"))
                .expect("stale portable path resolves against the current profile");
        assert_eq!(resolved, managed_file.canonicalize().expect("canonicalize"));

        // A path with no counterpart in the managed dir still fails, and names
        // the recorded path so the user can repair the reference (#1001).
        let missing = dir.path().join("elsewhere").join("report.pdf");
        let error =
            normalize_open_path(&missing.to_string_lossy(), Some(&managed_dir), Some("id-1"))
                .expect_err("unrelated missing file must not resolve");
        assert!(error.contains(&missing.display().to_string()), "{error}");

        let mismatched = normalize_open_path(
            &stale.to_string_lossy(),
            Some(&managed_dir),
            Some("different-id"),
        )
        .expect_err("fallback must stay bound to its attachment id");
        assert!(
            mismatched.contains(&stale.display().to_string()),
            "{mismatched}"
        );

        assert!(normalize_open_path(&stale.to_string_lossy(), Some(&managed_dir), None,).is_err());
    }

    // #1245 moved an installed Windows/macOS profile's managed folders from
    // <root>/ down into <root>/data/. Audio captures are the case the #1038
    // fallback cannot reach: the file name is a timestamp, never the attachment id.
    #[test]
    fn normalize_open_path_rehomes_a_flat_root_path_into_the_data_subfolder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("mindwtr");
        let managed_dir = root.join("data").join("attachments");
        let capture_dir = root.join("data").join("audio-captures");
        std::fs::create_dir_all(&managed_dir).expect("create managed dir");
        std::fs::create_dir_all(&capture_dir).expect("create capture dir");

        let capture = capture_dir.join("mindwtr-audio-1756-abc.wav");
        std::fs::write(&capture, b"riff").expect("write capture");
        let stale_capture = root.join("audio-captures").join("mindwtr-audio-1756-abc.wav");
        let resolved = normalize_open_path(
            &stale_capture.to_string_lossy(),
            Some(&managed_dir),
            Some("attachment-uuid"),
        )
        .expect("a capture recorded at the flat root resolves under data/");
        assert_eq!(resolved, capture.canonicalize().expect("canonicalize"));

        // Same rule for attachments whose file name is not the attachment id.
        let report = managed_dir.join("report.pdf");
        std::fs::write(&report, b"pdf").expect("write report");
        let stale_report = root.join("attachments").join("report.pdf");
        let resolved = normalize_open_path(&stale_report.to_string_lossy(), Some(&managed_dir), None)
            .expect("a flat-root attachment resolves under data/");
        assert_eq!(resolved, report.canonicalize().expect("canonicalize"));

        // A folder the move did not touch keeps failing on its recorded path.
        let pasted = root.join("quick-add-images").join("pasted-1.png");
        std::fs::create_dir_all(root.join("data").join("quick-add-images")).expect("create dir");
        std::fs::write(
            root.join("data").join("quick-add-images").join("pasted-1.png"),
            b"png",
        )
        .expect("write pasted");
        assert!(
            normalize_open_path(&pasted.to_string_lossy(), Some(&managed_dir), None).is_err(),
            "quick-add-images did not move, so its recorded paths must not be re-homed"
        );
    }

    // The re-homed path is still a trust boundary: only names, never traversal.
    #[test]
    fn normalize_open_path_refuses_to_rehome_outside_the_managed_data_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("mindwtr");
        let managed_dir = root.join("data").join("attachments");
        std::fs::create_dir_all(&managed_dir).expect("create managed dir");
        // Only reachable by joining the traversal onto the managed dir; the
        // recorded path itself points at a directory that does not exist.
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).expect("create outside dir");
        std::fs::write(outside.join("secrets.toml"), b"token").expect("write secret");

        let hostile = root
            .join("attachments")
            .join("..")
            .join("..")
            .join("outside")
            .join("secrets.toml");
        assert!(
            normalize_open_path(&hostile.to_string_lossy(), Some(&managed_dir), None).is_err(),
            "a traversal segment must never be re-homed"
        );
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
    fn link_folder_bookmarks_are_kept_per_attachment() {
        assert_eq!(link_folder_bookmark_for(None, "a"), None);
        let one = with_link_folder_bookmark(None, "a", "bm-a".to_string());
        let two = with_link_folder_bookmark(Some(&one), "b", "bm-b".to_string());
        assert_eq!(link_folder_bookmark_for(Some(&two), "a").as_deref(), Some("bm-a"));
        assert_eq!(link_folder_bookmark_for(Some(&two), "b").as_deref(), Some("bm-b"));
        assert_eq!(link_folder_bookmark_for(Some(&two), "c"), None);
        // Re-linking replaces; a corrupt map starts over instead of failing.
        let replaced = with_link_folder_bookmark(Some(&two), "a", "bm-a2".to_string());
        assert_eq!(link_folder_bookmark_for(Some(&replaced), "a").as_deref(), Some("bm-a2"));
        let fresh = with_link_folder_bookmark(Some("not json"), "a", "bm".to_string());
        assert_eq!(link_folder_bookmark_for(Some(&fresh), "a").as_deref(), Some("bm"));
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
