use crate::*;
use std::path::Component;

fn ensure_local_attachment_path(path: &str) -> Result<(), String> {
    let normalized = path.replace('\\', "/");
    let windows_path = normalized
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && normalized.as_bytes().get(1) == Some(&b':')
        && normalized.as_bytes().get(2) == Some(&b'/');
    let invalid_windows_component = windows_path
        && normalized[3..].split('/').any(|part| {
            let base = part
                .split('.')
                .next()
                .unwrap_or_default()
                .trim_end_matches(' ')
                .to_ascii_lowercase();
            let reserved = matches!(
                base.as_str(),
                "con" | "prn" | "aux" | "nul" | "clock$" | "conin$" | "conout$"
            ) || ["com", "lpt"].iter().any(|prefix| {
                base.strip_prefix(prefix).is_some_and(|suffix| {
                    matches!(
                        suffix,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            });
            part.contains(':')
                || (!matches!(part, "." | "..") && (part.ends_with('.') || part.ends_with(' ')))
                || reserved
        });
    if normalized.starts_with("//")
        || path.starts_with('\\')
        || path.chars().any(|character| character.is_ascii_control())
        || invalid_windows_component
    {
        return Err("Only local file paths can be opened.".to_string());
    }
    Ok(())
}

fn strip_file_scheme(raw: &str) -> Result<String, String> {
    let path = if raw.to_ascii_lowercase().starts_with("file:") {
        if !raw.to_ascii_lowercase().starts_with("file://") {
            return Err("Only local file paths can be opened.".to_string());
        }
        ensure_local_attachment_path(
            &raw[7..]
                .to_ascii_lowercase()
                .replace("%2f", "/")
                .replace("%5c", "\\"),
        )?;
        let url = reqwest::Url::parse(raw)
            .map_err(|_| "Only local file paths can be opened.".to_string())?;
        if url.host_str().is_some() {
            return Err("Only local file paths can be opened.".to_string());
        }
        url.to_file_path()
            .map_err(|_| "Only local file paths can be opened.".to_string())?
            .into_os_string()
            .into_string()
            .map_err(|_| "Only local file paths can be opened.".to_string())?
    } else {
        raw.to_string()
    };
    ensure_local_attachment_path(&path)?;
    Ok(path)
}

const RELOCATED_MANAGED_DIR_NAMES: &[&str] = &["attachments", "audio-captures"];

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
    normalize_open_path_with(raw, managed_attachments_dir, attachment_id, |path| {
        path.canonicalize()
    })
}

fn normalize_open_path_with(
    raw: &str,
    managed_attachments_dir: Option<&Path>,
    attachment_id: Option<&str>,
    canonicalize: impl Fn(&Path) -> std::io::Result<PathBuf>,
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
    if let Ok(resolved) = canonicalize(&candidate) {
        return require_local_resolved_path(resolved);
    }

    if let Some(resolved) = managed_attachments_dir
        .and_then(|dir| rehomed_managed_path(&candidate, dir))
        .and_then(|rehomed| canonicalize(&rehomed).ok())
    {
        return require_local_resolved_path(resolved);
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
        .and_then(|fallback| canonicalize(&fallback).ok())
        .ok_or_else(|| {
            format!(
                "File does not exist or cannot be accessed: {}",
                candidate.display()
            )
        })
        .and_then(require_local_resolved_path)
}

fn require_local_resolved_path(path: PathBuf) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    if !matches!(path.components().next(), Some(Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
    {
        return Err("Only local file paths can be opened.".to_string());
    }
    Ok(path)
}

const ATTACHMENT_DOCUMENT_EXTENSIONS: &[&str] = &[
    "pdf", "txt", "md", "markdown", "rst", "csv", "tsv", "log", "json", "yaml", "yml", "toml",
    "ini", "cfg", "conf", "xml", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
    "odp", "odg", "pages", "numbers", "key", "epub", "mobi", "png", "jpg", "jpeg", "gif", "webp",
    "bmp", "ico", "tif", "tiff", "heic", "heif", "avif", "m4a", "aac", "mp3", "wav", "caf", "ogg",
    "oga", "flac", "webm", "mp4", "m4v", "mov", "avi", "mkv", "mpg", "mpeg", "3gp", "3gpp", "zip",
    "gz", "bz2", "xz", "7z", "rar", "tar", "ics", "vcf",
];
const ATTACHMENT_BUNDLE_EXTENSIONS: &[&str] = &[
    "app",
    "bundle",
    "workflow",
    "scptd",
    "kext",
    "plugin",
    "prefpane",
    "framework",
    "component",
    "service",
    "action",
    "qlgenerator",
    "mdimporter",
    "saver",
    "appex",
    "xpc",
];

fn attachment_bundle_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            ATTACHMENT_BUNDLE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
        || path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().contains(".{"))
}

fn path_is_openable(path: &Path) -> Result<bool, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "Path does not exist or cannot be opened.".to_string())?;
    if metadata.is_dir() {
        return Ok(!attachment_bundle_path(path));
    }
    if !metadata.is_file() {
        return Err("Only local files and folders can be opened.".to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !ATTACHMENT_DOCUMENT_EXTENSIONS.contains(&extension.as_str()) {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            return Ok(false);
        }
    }
    let mut file = fs::File::open(path).map_err(|_| "File cannot be read safely.".to_string())?;
    let mut header = [0u8; 512];
    let length = file
        .read(&mut header)
        .map_err(|_| "File cannot be read safely.".to_string())?;
    let header = &header[..length];
    let blocked = header.starts_with(b"MZ")
        || header.starts_with(b"\x7fELF")
        || header.starts_with(b"#!")
        || header.starts_with(b"\xef\xbb\xbf#!")
        || header
            .windows(b"[Desktop Entry]".len())
            .any(|part| part == b"[Desktop Entry]")
        || [
            [0xfe, 0xed, 0xfa, 0xce],
            [0xfe, 0xed, 0xfa, 0xcf],
            [0xce, 0xfa, 0xed, 0xfe],
            [0xcf, 0xfa, 0xed, 0xfe],
            [0xca, 0xfe, 0xba, 0xbe],
            [0xbe, 0xba, 0xfe, 0xca],
            [0xca, 0xfe, 0xba, 0xbf],
            [0xbf, 0xba, 0xfe, 0xca],
            [0x4c, 0x00, 0x00, 0x00],
        ]
        .iter()
        .any(|signature| header.starts_with(signature));
    Ok(!blocked)
}

fn open_local_attachment(
    path: &Path,
    opener: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<bool, String> {
    let openable = path_is_openable(path)?;
    let mut target = path;
    if !openable {
        loop {
            target = target
                .parent()
                .ok_or_else(|| "The attachment folder cannot be opened.".to_string())?;
            if !attachment_bundle_path(target) {
                break;
            }
        }
    }
    opener(target).map_err(|_| "Path does not exist or cannot be opened.".to_string())?;
    let outcome = if openable {
        "opened-local"
    } else {
        "revealed-folder"
    };
    log::info!("Attachment launch policy applied extra.releaseCheck=v1.3.9/attachment-open-policy outcome={outcome}");
    Ok(true)
}

#[cfg(target_os = "macos")]
fn parse_macos_eventkit_json(raw: *mut c_char) -> Result<Value, String> {
    if raw.is_null() {
        return Err("EventKit bridge returned null output".to_string());
    }

    let text = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    unsafe { mindwtr_macos_calendar_free_string(raw) };
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Failed to parse EventKit bridge output: {error}"))
}

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

#[tauri::command(async)]
pub(crate) fn import_attachment_file(
    app: tauri::AppHandle,
    path: String,
    file_name: String,
    max_bytes: Option<u64>,
) -> Result<ImportedAttachmentFile, String> {
    let source = PathBuf::from(strip_file_scheme(path.trim())?);

    let dest_dir = get_data_dir(&app).join("attachments");
    let (final_path, size) = import_attachment_into(&dest_dir, &source, &file_name, max_bytes)?;
    Ok(ImportedAttachmentFile {
        uri: final_path.to_string_lossy().into_owned(),
        size,
    })
}

#[tauri::command]
pub(crate) fn get_managed_data_dir(app: tauri::AppHandle) -> String {
    get_data_dir(&app).to_string_lossy().into_owned()
}

#[tauri::command(async)]
pub(crate) fn get_device_managed_data_dir(app: tauri::AppHandle) -> String {
    crate::storage::get_device_data_dir(&app)
        .to_string_lossy()
        .into_owned()
}

fn legacy_webview_data_root() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("mindwtr"))
}

fn standard_install_present(legacy_root: &Path) -> bool {
    use crate::storage_layout::{CONFIG_DIR_NAME, DATA_DIR_NAME, DATA_JSON_BACKUP_FILE_NAME};

    let data_subfolder = legacy_root.join(DATA_DIR_NAME);
    let data_present = [legacy_root, &data_subfolder].iter().any(|root| {
        root.join(DATA_FILE_NAME).exists()
            || root.join(DB_FILE_NAME).exists()
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

#[cfg(any(target_os = "macos", test))]
fn with_link_folder_bookmark(raw: Option<&str>, attachment_id: &str, bookmark: String) -> String {
    let mut map = raw
        .and_then(|raw| serde_json::from_str::<Map<String, Value>>(raw).ok())
        .unwrap_or_default();
    map.insert(attachment_id.to_string(), Value::String(bookmark));
    Value::Object(map).to_string()
}

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
        2 => "revealed",
        0 => "fallback",
        _ => "open-failed",
    };
    log::info!("Linked folder opened through its bookmark extra.releaseCheck=v1.3.4/link-folder-bookmark outcome={label}");
    if matches!(outcome, 1 | 2) {
        log::info!("Attachment launch policy applied extra.releaseCheck=v1.3.9/attachment-open-policy outcome=bookmarked-folder-{label}");
    }
    match outcome {
        1 | 2 => Ok(true),
        0 => Ok(false),
        _ => Err("Path does not exist or cannot be opened.".to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn open_path(
    app: tauri::AppHandle,
    path: String,
    attachment_id: Option<String>,
) -> Result<bool, String> {
    if let Err(error) = strip_file_scheme(path.trim()) {
        log::warn!("Attachment path refused extra.releaseCheck=v1.3.9/attachment-open-policy outcome=refused-path");
        return Err(error);
    }
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
    open_local_attachment(&normalized, |target| open::that_detached(target))
}

#[cfg(test)]
mod tests {
    use super::*;

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

        assert!(!standard_install_present(root));

        let markers = [
            root.join(DB_FILE_NAME),
            root.join(DATA_FILE_NAME),
            root.join(CONFIG_FILE_NAME),
            root.join(DATA_JSON_BACKUP_FILE_NAME),
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

        let report = managed_dir.join("report.pdf");
        std::fs::write(&report, b"pdf").expect("write report");
        let stale_report = root.join("attachments").join("report.pdf");
        let resolved = normalize_open_path(&stale_report.to_string_lossy(), Some(&managed_dir), None)
            .expect("a flat-root attachment resolves under data/");
        assert_eq!(resolved, report.canonicalize().expect("canonicalize"));

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

    #[test]
    fn normalize_open_path_refuses_to_rehome_outside_the_managed_data_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("mindwtr");
        let managed_dir = root.join("data").join("attachments");
        std::fs::create_dir_all(&managed_dir).expect("create managed dir");

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
    fn path_is_openable_allows_existing_user_selected_files() {
        let temp = tempfile::tempdir().expect("should create temp dir");
        let attachment_path = temp.path().join("notes.md");
        fs::write(&attachment_path, "notes").expect("should write attachment");

        assert!(path_is_openable(&attachment_path).expect("policy"));
    }

    #[test]
    fn path_is_openable_refuses_to_launch_script_and_shortcut_attachments() {
        let temp = tempfile::tempdir().expect("temp dir");
        for name in [
            "report.cmd",
            "report.exe",
            "report.bat",
            "report.ps1",
            "report.sh",
            "report.lnk",
            "report.url",
            "report.hta",
            "report.msi",
            "report.msc",
            "report.jar",
            "report.desktop",
            "report.search-ms",
            "report.library-ms",
            "report",
            "report.custom",
        ] {
            let path = temp.path().join(name);
            fs::write(&path, b"attachment").expect("attachment");
            assert!(!path_is_openable(&path).expect("policy"), "{name}");
            open_local_attachment(&path, |target| {
                assert_eq!(target, temp.path(), "{name}");
                Ok(())
            })
            .expect("reveal folder");
        }
    }

    #[test]
    fn attachment_open_policy_inspects_bytes_instead_of_document_extensions() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("report.pdf");
        for bytes in [
            b"MZpayload".as_slice(),
            b"\x7fELFpayload",
            b"#!/bin/sh",
            b"\xef\xbb\xbf#!/bin/sh",
            b"\xfe\xed\xfa\xce",
            b"\xcf\xfa\xed\xfe",
            b"\xca\xfe\xba\xbe",
            b"\xca\xfe\xba\xbf",
            b"\x4c\x00\x00\x00",
            b"[Desktop Entry]\nType=Application",
        ] {
            fs::write(&path, bytes).expect("file");
            open_local_attachment(&path, |target| {
                assert_eq!(target, temp.path());
                Ok(())
            })
            .expect("reveal");
        }
        for name in [
            "report.pdf",
            "notes.md",
            "photo.png",
            "recording.wav",
            "archive.zip",
        ] {
            let path = temp.path().join(name);
            fs::write(&path, b"document").expect("file");
            open_local_attachment(&path, |target| {
                assert_eq!(target, path);
                Ok(())
            })
            .expect("document open");
        }
    }

    #[test]
    fn attachment_open_policy_reveals_app_bundles_without_launching_their_parent_bundle() {
        let temp = tempfile::tempdir().expect("temp dir");
        let bundle = temp.path().join("Example.app");
        fs::create_dir(&bundle).expect("bundle");
        let nested = bundle.join("Nested.app");
        fs::create_dir(&nested).expect("nested bundle");
        for path in [&bundle, &nested] {
            open_local_attachment(path, |target| {
                assert_eq!(target, temp.path());
                Ok(())
            })
            .expect("reveal");
        }
    }

    #[test]
    fn attachment_open_policy_rejects_remote_and_device_paths_before_filesystem_access() {
        for raw in [
            r"\\host\share\report.pdf",
            "//host/share/report.pdf",
            r"\\?\UNC\host\share\report.pdf",
            r"\\?\C:\report.pdf",
            r"\\.\C:\report.pdf",
            r"\??\C:\report.pdf",
            "file://host/share/report.pdf",
            "file:////host/share/report.pdf",
            "file:///%5c%5chost/share/report.pdf",
            "file:///%2fhost/share/report.pdf",
            r"C:\report.pdf:payload.cmd",
            r"C:\NUL.pdf",
            r"C:\CON .txt",
            r"C:\COM1.txt",
            r"C:\report.cmd.\safe.pdf",
        ] {
            let result =
                normalize_open_path_with(raw, None, None, |_| panic!("filesystem probe: {raw}"));
            assert_eq!(
                result.unwrap_err(),
                "Only local file paths can be opened.",
                "{raw}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn attachment_open_policy_reveals_executable_documents_and_resolved_script_symlinks() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("report.pdf");
        fs::write(&path, b"document").expect("file");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("permissions");
        open_local_attachment(&path, |target| {
            assert_eq!(target, temp.path());
            Ok(())
        })
        .expect("reveal");
        let script = temp.path().join("payload.sh");
        fs::write(&script, b"payload").expect("script");
        let link = temp.path().join("linked.pdf");
        symlink(&script, &link).expect("symlink");
        let resolved =
            normalize_open_path(link.to_str().expect("path"), None, None).expect("resolve");
        open_local_attachment(&resolved, |target| {
            assert_eq!(target, temp.path());
            Ok(())
        })
        .expect("reveal");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn attachment_open_policy_accepts_canonical_drive_prefixes_and_refuses_resolved_unc_paths() {
        let canonical = PathBuf::from(r"\\?\C:\Documents\report.pdf");
        assert_eq!(
            normalize_open_path_with(r"C:\Documents\report.pdf", None, None, |_| Ok(
                canonical.clone()
            ))
            .expect("local"),
            canonical
        );
        assert!(
            normalize_open_path_with(r"C:\Documents\report.pdf", None, None, |_| Ok(
                PathBuf::from(r"\\?\UNC\host\share\report.pdf")
            ))
            .is_err()
        );
    }

    #[test]
    fn link_folder_bookmarks_are_kept_per_attachment() {
        assert_eq!(link_folder_bookmark_for(None, "a"), None);
        let one = with_link_folder_bookmark(None, "a", "bm-a".to_string());
        let two = with_link_folder_bookmark(Some(&one), "b", "bm-b".to_string());
        assert_eq!(link_folder_bookmark_for(Some(&two), "a").as_deref(), Some("bm-a"));
        assert_eq!(link_folder_bookmark_for(Some(&two), "b").as_deref(), Some("bm-b"));
        assert_eq!(link_folder_bookmark_for(Some(&two), "c"), None);

        let replaced = with_link_folder_bookmark(Some(&two), "a", "bm-a2".to_string());
        assert_eq!(link_folder_bookmark_for(Some(&replaced), "a").as_deref(), Some("bm-a2"));
        let fresh = with_link_folder_bookmark(Some("not json"), "a", "bm".to_string());
        assert_eq!(link_folder_bookmark_for(Some(&fresh), "a").as_deref(), Some("bm"));
    }

    #[test]
    fn path_is_openable_allows_existing_user_linked_directories() {
        let temp = tempfile::tempdir().expect("should create temp dir");

        assert!(path_is_openable(temp.path()).expect("policy"));
    }

    #[test]
    fn path_is_openable_rejects_missing_paths() {
        let temp = tempfile::tempdir().expect("should create temp dir");

        assert!(path_is_openable(&temp.path().join("does-not-exist")).is_err());
    }
}

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
