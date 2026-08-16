use crate::obsidian_paths::normalize_obsidian_inbox_file;
use crate::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

const KEYRING_FALLBACK_WARNING_EVENT: &str = "keyring-fallback-warning";
const CONFIG_CREDENTIAL_STATE_FILE_NAME: &str = "config-credential-state.json";
const CONFIG_CREDENTIAL_STATE_VERSION: u8 = 1;

fn keyring_enabled() -> bool {
    !crate::storage::is_portable_mode()
}

pub(crate) fn emit_keyring_fallback_warning(app: &tauri::AppHandle, secret_name: &str) {
    let message =
        format!("{secret_name} stored in plaintext because the system keyring is unavailable.");
    if let Err(error) = app.emit(KEYRING_FALLBACK_WARNING_EVENT, message) {
        log::warn!("Failed to emit keyring fallback warning: {error}");
    }
}

fn calendar_file_url_to_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if !trimmed
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        return None;
    }

    let path = &trimmed[7..];
    #[cfg(target_os = "windows")]
    let path = {
        let mut path = path;
        let bytes = path.as_bytes();
        if bytes.len() >= 3 && bytes[0] == b'/' && bytes[2] == b':' {
            path = &path[1..];
        }
        path
    };
    let candidate = PathBuf::from(percent_decode_file_path(path)?);
    if !candidate.is_absolute() {
        return None;
    }
    let has_ics_extension = candidate
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ics"));
    if !has_ics_extension {
        return None;
    }
    Some(candidate)
}

fn percent_decode_file_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hi = bytes.get(index + 1).and_then(|value| hex_value(*value))?;
            let lo = bytes.get(index + 2).and_then(|value| hex_value(*value))?;
            decoded.push((hi << 4) | lo);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn is_valid_calendar_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("webcal://")
        || calendar_file_url_to_path(trimmed).is_some()
}

/// Resolves a calendar URL to a path only when it is one of the stored
/// subscriptions, so the webview cannot turn the read command into an
/// arbitrary-file-read primitive.
fn configured_calendar_file_path(raw: Option<&str>, url: &str) -> Option<PathBuf> {
    let trimmed = url.trim();
    let calendars = serde_json::from_str::<Vec<ExternalCalendarSubscription>>(raw?).ok()?;
    if !calendars
        .iter()
        .any(|calendar| calendar.url.trim() == trimmed)
    {
        return None;
    }
    calendar_file_url_to_path(trimmed)
}

pub(crate) fn parse_toml_string_value(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(stripped) = trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        return Some(stripped.replace("\\\"", "\"").replace("\\\\", "\\"));
    }
    if let Some(stripped) = trimmed
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
    {
        return Some(stripped.to_string());
    }
    None
}

pub(crate) fn read_config_toml(path: &Path) -> AppConfigToml {
    let Ok(content) = fs::read_to_string(path) else {
        return AppConfigToml::default();
    };
    // A file that isn't valid TOML falls back to default() here — same as a
    // missing file — rather than the old hand-rolled parser's per-line
    // recovery. On its own that would be a silent-loss regression the moment
    // a caller writes the "empty" config back over the real file; see the
    // guard in `write_config_toml_with_header` below, which is what actually
    // keeps that from happening.
    toml::from_str(&content).unwrap_or_default()
}

#[cfg(test)]
fn write_config_toml(path: &Path, config: &AppConfigToml) -> Result<(), String> {
    write_config_toml_with_header(path, config, "# Mindwtr desktop config")
}

#[cfg(test)]
fn write_secrets_toml(path: &Path, config: &AppConfigToml) -> Result<(), String> {
    write_secrets_toml_with_restrict(path, config, restrict_to_owner)
}

/// Restricts a path holding credentials to owner-only access. No-op on
/// Windows, where file ACLs are not expressible through
/// `std::fs::Permissions`.
#[cfg(unix)]
fn restrict_to_owner(path: &Path, mode: u32) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
fn write_secrets_toml_with_restrict<F>(
    path: &Path,
    config: &AppConfigToml,
    restrict: F,
) -> Result<(), String>
where
    F: FnMut(&Path, u32) -> Result<(), String>,
{
    write_secrets_toml_with_hooks(path, config, restrict, |temp_file, destination| {
        temp_file
            .persist(destination)
            .map(|_| ())
            .map_err(|error| error.error.to_string())
    })
}

#[cfg(unix)]
fn sync_config_parent_directory(parent: &Path) -> Result<(), String> {
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn sync_config_parent_directory(_parent: &Path) -> Result<(), String> {
    // Windows has no documented equivalent of fsyncing a directory. Its
    // namespace barrier lives in `publish_atomic_temp_file` (and the durable
    // deletion path) via MOVEFILE_WRITE_THROUGH instead.
    Ok(())
}

#[cfg(windows)]
fn windows_path_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn windows_move_file_write_through(source: &Path, destination: &Path) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = windows_path_wide(source);
    let destination = windows_path_wide(destination);
    // SAFETY: both buffers are NUL-terminated and remain alive for the call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn publish_atomic_temp_file(
    temp_file: tempfile::NamedTempFile,
    destination: &Path,
) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        SetFileAttributesW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_TEMPORARY,
    };

    let source_path = temp_file.path().to_path_buf();
    let source = windows_path_wide(&source_path);
    // tempfile marks named files temporary on Windows. Normalize the attribute
    // before publishing so the committed file has ordinary persistence rules.
    // SAFETY: `source` is NUL-terminated and alive for the call.
    if unsafe { SetFileAttributesW(source.as_ptr(), FILE_ATTRIBUTE_NORMAL) } == 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    if let Err(error) = windows_move_file_write_through(&source_path, destination) {
        // Best effort: preserve tempfile's cleanup behavior after a failed move.
        // SAFETY: `source` is NUL-terminated and alive for the call.
        let _ = unsafe { SetFileAttributesW(source.as_ptr(), FILE_ATTRIBUTE_TEMPORARY) };
        return Err(error);
    }
    drop(temp_file);
    Ok(())
}

#[cfg(not(windows))]
fn publish_atomic_temp_file(
    temp_file: tempfile::NamedTempFile,
    destination: &Path,
) -> Result<(), String> {
    temp_file
        .persist(destination)
        .map(|_| ())
        .map_err(|error| error.error.to_string())
}

fn dropbox_credential_state_path_from_secrets_path(secrets_path: &Path) -> PathBuf {
    secrets_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(DROPBOX_CREDENTIAL_STATE_FILE_NAME)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigPublicationPending {
    generation: u64,
    config_fingerprint: Option<String>,
    secrets_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialBinding {
    generation: u64,
    endpoint_fingerprint: String,
    credential_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialBindingPending {
    service: String,
    generation: u64,
    endpoint_fingerprint: String,
    credential_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigCredentialStateFile {
    version: u8,
    config_generation: u64,
    config_fingerprint: Option<String>,
    secrets_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_config: Option<ConfigPublicationPending>,
    #[serde(default)]
    credential_generation: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    bindings: BTreeMap<String, CredentialBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_credential: Option<CredentialBindingPending>,
}

impl ConfigCredentialStateFile {
    fn from_current_files(config_path: &Path, secrets_path: &Path) -> Result<Self, String> {
        Ok(Self {
            version: CONFIG_CREDENTIAL_STATE_VERSION,
            config_generation: 0,
            config_fingerprint: fingerprint_optional_file(config_path)?,
            secrets_fingerprint: fingerprint_optional_file(secrets_path)?,
            pending_config: None,
            credential_generation: 0,
            bindings: BTreeMap::new(),
            pending_credential: None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigPublicationStage {
    PendingState,
    PublicConfig,
    SecretConfig,
    ReadBack,
    CommittedState,
}

impl ConfigPublicationStage {
    #[cfg(test)]
    const ALL: [Self; 5] = [
        Self::PendingState,
        Self::PublicConfig,
        Self::SecretConfig,
        Self::ReadBack,
        Self::CommittedState,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CredentialService {
    Webdav,
    Cloud,
    Email,
}

impl CredentialService {
    fn from_state_key(value: &str) -> Option<Self> {
        match value {
            "webdav" => Some(Self::Webdav),
            "cloud" => Some(Self::Cloud),
            "email" => Some(Self::Email),
            _ => None,
        }
    }

    fn state_key(self) -> &'static str {
        match self {
            Self::Webdav => "webdav",
            Self::Cloud => "cloud",
            Self::Email => "email",
        }
    }

    fn keyring_key(self) -> &'static str {
        match self {
            Self::Webdav => KEYRING_WEB_DAV_PASSWORD,
            Self::Cloud => KEYRING_CLOUD_TOKEN,
            Self::Email => KEYRING_EMAIL_CAPTURE_PASSWORD,
        }
    }

    fn fallback<'a>(self, config: &'a AppConfigToml) -> Option<&'a str> {
        match self {
            Self::Webdav => config.webdav_password.as_deref(),
            Self::Cloud => config.cloud_token.as_deref(),
            Self::Email => config.email_capture_password.as_deref(),
        }
    }

    fn set_fallback(self, config: &mut AppConfigToml, value: Option<String>) {
        match self {
            Self::Webdav => config.webdav_password = value,
            Self::Cloud => config.cloud_token = value,
            Self::Email => config.email_capture_password = value,
        }
    }

    fn endpoint_identity(self, config: &AppConfigToml) -> Value {
        match self {
            Self::Webdav => serde_json::json!({
                "url": config.webdav_url.as_deref().unwrap_or("").trim(),
                "username": config.webdav_username.as_deref().unwrap_or("").trim(),
                "allowInsecureHttp": config.webdav_allow_insecure_http.as_deref() == Some("true"),
                "allowWeakFingerprint": config.webdav_allow_weak_fingerprint.as_deref() != Some("false"),
            }),
            Self::Cloud => serde_json::json!({
                "url": config.cloud_url.as_deref().unwrap_or("").trim(),
                "allowInsecureHttp": config.cloud_allow_insecure_http.as_deref() == Some("true"),
            }),
            Self::Email => serde_json::json!({
                "config": config
                    .email_capture_config
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                    .unwrap_or(Value::Null),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CredentialSecretUpdate {
    Keep,
    Replace(Option<String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialPublicationStage {
    PendingState,
    SecretStore,
    ConfigPair,
    ReadBack,
    CommittedState,
}

impl CredentialPublicationStage {
    #[cfg(test)]
    const ALL: [Self; 5] = [
        Self::PendingState,
        Self::SecretStore,
        Self::ConfigPair,
        Self::ReadBack,
        Self::CommittedState,
    ];
}

fn config_credential_state_path_from_secrets_path(secrets_path: &Path) -> PathBuf {
    secrets_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(CONFIG_CREDENTIAL_STATE_FILE_NAME)
}

fn config_rollback_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    path.parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".{name}.mindwtr-rollback"))
}

fn fingerprint_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fingerprint_optional_file(path: &Path) -> Result<Option<String>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(fingerprint_bytes(&bytes))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to fingerprint {}: {error}", path.display())),
    }
}

pub(crate) fn get_dropbox_credential_state_path(app: &tauri::AppHandle) -> PathBuf {
    crate::storage::get_config_dir(app).join(DROPBOX_CREDENTIAL_STATE_FILE_NAME)
}

fn write_owner_only_atomic_text(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve private state directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    restrict_to_owner(parent, 0o700)?;
    if path.exists() {
        restrict_to_owner(path, 0o600)?;
    }
    write_atomic_text_with_hooks(
        path,
        content,
        true,
        publish_atomic_temp_file,
        sync_config_parent_directory,
    )
}

fn write_atomic_text(path: &Path, content: &str, owner_only: bool) -> Result<(), String> {
    write_atomic_text_with_hooks(
        path,
        content,
        owner_only,
        publish_atomic_temp_file,
        sync_config_parent_directory,
    )
}

fn write_atomic_text_with_hooks<Publish, SyncParent>(
    path: &Path,
    content: &str,
    owner_only: bool,
    publish: Publish,
    sync_parent: SyncParent,
) -> Result<(), String>
where
    Publish: FnOnce(tempfile::NamedTempFile, &Path) -> Result<(), String>,
    SyncParent: FnOnce(&Path) -> Result<(), String>,
{
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve config directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp_file = tempfile::Builder::new()
        .prefix(".mindwtr-config-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| e.to_string())?;
    if owner_only {
        restrict_to_owner(temp_file.path(), 0o600)?;
    }
    temp_file
        .write_all(content.as_bytes())
        .and_then(|_| temp_file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    publish(temp_file, path)?;
    if owner_only {
        restrict_to_owner(path, 0o600)?;
    }
    sync_parent(parent)
}

#[cfg(windows)]
fn config_deletion_tombstone_path(path: &Path) -> Result<PathBuf, String> {
    use std::ffi::OsString;

    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve config directory".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "Failed to resolve config file name".to_string())?;
    let mut tombstone_name = OsString::from(".");
    tombstone_name.push(file_name);
    tombstone_name.push(".mindwtr-delete");
    Ok(parent.join(tombstone_name))
}

#[cfg(windows)]
fn securely_clear_windows_deletion_tombstone(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve config directory".to_string())?;
    let empty_file = tempfile::Builder::new()
        .prefix(".mindwtr-delete-empty-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| error.to_string())?;
    empty_file
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    // If a crash resurrects the final unlink, it can reveal only this durable
    // empty replacement, never the removed credential bytes.
    publish_atomic_temp_file(empty_file, path)?;
    fs::remove_file(path).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn remove_config_file_for_platform(path: &Path) -> Result<bool, String> {
    let tombstone_path = config_deletion_tombstone_path(path)?;
    if !path.try_exists().map_err(|error| error.to_string())? {
        if tombstone_path
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            securely_clear_windows_deletion_tombstone(&tombstone_path)?;
        }
        return Ok(false);
    }

    // Windows has no documented directory-fsync primitive. A same-directory
    // write-through rename makes removal of the canonical name durable. The
    // tombstone is then durably replaced with empty content before unlinking.
    windows_move_file_write_through(path, &tombstone_path)?;
    securely_clear_windows_deletion_tombstone(&tombstone_path)?;
    Ok(true)
}

#[cfg(not(windows))]
fn remove_config_file_for_platform(path: &Path) -> Result<bool, String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_file_durably(path: &Path) -> Result<(), String> {
    remove_file_durably_with_hooks(
        path,
        remove_config_file_for_platform,
        sync_config_parent_directory,
    )
}

fn remove_file_durably_with_hooks<Remove, SyncParent>(
    path: &Path,
    remove: Remove,
    sync_parent: SyncParent,
) -> Result<(), String>
where
    Remove: FnOnce(&Path) -> Result<bool, String>,
    SyncParent: FnOnce(&Path) -> Result<(), String>,
{
    if !remove(path)? {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve config directory".to_string())?;
    sync_parent(parent)
}

fn read_config_credential_state_file(
    path: &Path,
) -> Result<Option<ConfigCredentialStateFile>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Failed to inspect config credential state".to_string()),
    };
    let state: ConfigCredentialStateFile =
        serde_json::from_str(&raw).map_err(|_| "Config credential state is invalid".to_string())?;
    if state.version != CONFIG_CREDENTIAL_STATE_VERSION {
        return Err("Config credential state has an unsupported version".to_string());
    }
    Ok(Some(state))
}

fn write_config_credential_state_file(
    path: &Path,
    state: &ConfigCredentialStateFile,
) -> Result<(), String> {
    if state.version != CONFIG_CREDENTIAL_STATE_VERSION {
        return Err("Config credential state has an unsupported version".to_string());
    }
    let payload = serde_json::to_string(state)
        .map_err(|_| "Failed to serialize config credential state".to_string())?;
    write_owner_only_atomic_text(path, &payload)?;
    let persisted = read_config_credential_state_file(path)?
        .ok_or_else(|| "Config credential state is missing after write".to_string())?;
    if persisted != *state {
        return Err("Config credential state failed durable read-back verification".to_string());
    }
    Ok(())
}

fn read_optional_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

fn restore_optional_file(
    path: &Path,
    bytes: Option<&[u8]>,
    owner_only: bool,
) -> Result<(), String> {
    match bytes {
        Some(bytes) => {
            let content = std::str::from_utf8(bytes)
                .map_err(|_| format!("Failed to restore {}", path.display()))?;
            write_atomic_text(path, content, owner_only)
        }
        None => remove_file_durably(path),
    }
}

fn cleanup_config_rollback_files(config_path: &Path, secrets_path: &Path) {
    let _ = remove_file_durably(&config_rollback_path(config_path));
    let _ = remove_file_durably(&config_rollback_path(secrets_path));
}

fn read_dropbox_credential_state_file(
    path: &Path,
) -> Result<Option<DropboxCredentialStateFile>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Failed to inspect the Dropbox credential state".to_string()),
    };
    let state: DropboxCredentialStateFile = serde_json::from_str(&raw)
        .map_err(|_| "Dropbox credential state is invalid".to_string())?;
    validate_dropbox_credential_state(&state)?;
    Ok(Some(state))
}

fn validate_dropbox_credential_state(state: &DropboxCredentialStateFile) -> Result<(), String> {
    if state.version != DROPBOX_CREDENTIAL_STATE_VERSION {
        return Err("Dropbox credential state has an unsupported version".to_string());
    }
    if normalize_backend(state.sync_backend_marker.trim()).is_none() {
        return Err("Dropbox credential state has an invalid backend marker".to_string());
    }
    if !matches!(state.cloud_provider.trim(), "selfhosted" | "dropbox") {
        return Err("Dropbox credential state has an invalid cloud provider".to_string());
    }
    if !matches!(
        state.cloud_provider_authority.trim(),
        "uninitialized" | "native"
    ) {
        return Err("Dropbox credential state has an invalid provider authority".to_string());
    }
    if state.resolved_credential_handles.iter().any(|handle| {
        handle.handle_fingerprint.trim().is_empty()
            || handle.client_id.trim().is_empty()
            || handle.candidate_fingerprint.trim().is_empty()
            || handle.resolved_at_ms < 0
    }) {
        return Err("Dropbox credential state has an invalid resolved handle".to_string());
    }
    Ok(())
}

fn write_dropbox_credential_state_file(
    path: &Path,
    state: &DropboxCredentialStateFile,
) -> Result<(), String> {
    validate_dropbox_credential_state(state)?;
    let payload = serde_json::to_string(state)
        .map_err(|_| "Failed to serialize the Dropbox credential state".to_string())?;
    write_owner_only_atomic_text(path, &payload)?;
    let persisted = read_dropbox_credential_state_file(path)?
        .ok_or_else(|| "Dropbox credential state is missing after write".to_string())?;
    if persisted != *state {
        return Err("Dropbox credential state failed durable read-back verification".to_string());
    }
    Ok(())
}

#[cfg(test)]
fn write_secrets_toml_with_hooks<F, P>(
    path: &Path,
    config: &AppConfigToml,
    mut restrict: F,
    publish: P,
) -> Result<(), String>
where
    F: FnMut(&Path, u32) -> Result<(), String>,
    P: FnOnce(tempfile::NamedTempFile, &Path) -> Result<(), String>,
{
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve secrets directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    restrict(parent, 0o700)?;
    if path.exists() {
        // A pre-fix file may already be too broad. Tighten it before reading
        // or replacing it so this write cannot extend the exposure window.
        restrict(path, 0o600)?;
    }
    let content = serialize_config_toml_with_header(path, config, "# Mindwtr desktop secrets")?;
    let mut temp_file = tempfile::Builder::new()
        .prefix(".mindwtr-secrets-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| e.to_string())?;
    // Protect the empty file before the first credential byte is written.
    // Even a permissive process umask therefore cannot expose plaintext.
    restrict(temp_file.path(), 0o600)?;
    temp_file
        .write_all(content.as_bytes())
        .and_then(|_| temp_file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    publish(temp_file, path)?;
    restrict(path, 0o600)?;
    sync_config_parent_directory(parent)
}

fn preflight_existing_config_toml(path: &Path) -> Result<(), String> {
    // Refuse to overwrite a file whose current on-disk content this build
    // cannot parse. Every read-modify-write call site reads via
    // `read_config_toml`, which silently falls back to `default()` on a
    // parse failure; without this guard, writing that "empty" config back
    // would permanently erase whatever was actually on disk. A missing file
    // (first write) is not a failure and is not blocked.
    match fs::read_to_string(path) {
        Ok(existing) => {
            if !existing.trim().is_empty() && toml::from_str::<AppConfigToml>(&existing).is_err() {
                return Err(format!(
                    "Refusing to overwrite {}: its current contents could not be parsed. \
                     Fix or remove the file by hand, then retry.",
                    path.display()
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Refusing to overwrite {} because it could not be read: {error}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn serialize_config_toml_with_header(
    path: &Path,
    config: &AppConfigToml,
    header: &str,
) -> Result<String, String> {
    preflight_existing_config_toml(path)?;
    let body = toml::to_string(config).map_err(|e| e.to_string())?;
    Ok(format!("{header}\n{body}"))
}

#[cfg(test)]
fn write_config_toml_with_header(
    path: &Path,
    config: &AppConfigToml,
    header: &str,
) -> Result<(), String> {
    let content = serialize_config_toml_with_header(path, config, header)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

/// Converts an `AppConfigToml` to its generic JSON-object view. Both
/// `merge_config` and `split_config_for_secrets` shuffle fields between two
/// `AppConfigToml` values by key name instead of restating the field roster,
/// so a new field only ever needs to be declared once, on the struct itself.
fn config_as_object(config: &AppConfigToml) -> Map<String, Value> {
    match serde_json::to_value(config).expect("AppConfigToml serializes infallibly") {
        Value::Object(map) => map,
        _ => unreachable!("AppConfigToml always serializes to a JSON object"),
    }
}

fn object_as_config(map: Map<String, Value>) -> AppConfigToml {
    serde_json::from_value(Value::Object(map))
        .expect("a subset of AppConfigToml's own fields always deserializes")
}

fn merge_config(base: &mut AppConfigToml, overrides: AppConfigToml) {
    let mut merged = config_as_object(base);
    for (key, value) in config_as_object(&overrides) {
        if !value.is_null() {
            merged.insert(key, value);
        }
    }
    *base = object_as_config(merged);
}

pub(crate) fn read_config(app: &tauri::AppHandle) -> AppConfigToml {
    let config_path = get_config_path(app);
    let secrets_path = get_secrets_path(app);
    let mut config = match read_config_files_verified(&config_path, &secrets_path) {
        Ok(config) => config,
        Err(error) => {
            log::error!("Config generation verification failed: {error}");
            return AppConfigToml::default();
        }
    };
    if get_dropbox_credential_state_path(app).exists() {
        config.dropbox_tokens = None;
        config.dropbox_promotion_journal = None;
    }
    if keyring_enabled() {
        migrate_legacy_secrets(app, &mut config);
    }
    config
}

// The one place to check when adding a credential field: list it here and
// `split_config_for_secrets` keeps it out of the plaintext config.toml. This
// is real policy (which fields may never touch the public file), not
// derivable from the struct itself, so it stays its own table rather than an
// attribute a refactor could quietly drop.
const SECRET_FIELDS: &[&str] = &[
    "webdav_password",
    "cloud_token",
    "dropbox_tokens",
    "dropbox_promotion_journal",
    "external_calendars",
    "ai_key_openai",
    "ai_key_anthropic",
    "ai_key_gemini",
    "email_capture_password",
    "local_api_token",
];

fn split_config_for_secrets(config: &AppConfigToml) -> (AppConfigToml, AppConfigToml) {
    let mut public_map = config_as_object(config);
    let mut secrets_map = Map::new();
    for &field in SECRET_FIELDS {
        if let Some(value) = public_map.remove(field).filter(|value| !value.is_null()) {
            secrets_map.insert(field.to_string(), value);
        }
    }
    (object_as_config(public_map), object_as_config(secrets_map))
}

fn config_has_values(config: &AppConfigToml) -> bool {
    *config != AppConfigToml::default()
}

fn config_pair_matches_state(
    config_path: &Path,
    secrets_path: &Path,
    config_fingerprint: &Option<String>,
    secrets_fingerprint: &Option<String>,
) -> Result<bool, String> {
    Ok(
        fingerprint_optional_file(config_path)? == *config_fingerprint
            && fingerprint_optional_file(secrets_path)? == *secrets_fingerprint,
    )
}

fn recover_config_publication_unlocked(
    config_path: &Path,
    secrets_path: &Path,
) -> Result<Option<ConfigCredentialStateFile>, String> {
    let state_path = config_credential_state_path_from_secrets_path(secrets_path);
    let Some(mut state) = read_config_credential_state_file(&state_path)? else {
        return Ok(None);
    };

    if let Some(pending) = state.pending_config.clone() {
        let committed_matches = config_pair_matches_state(
            config_path,
            secrets_path,
            &state.config_fingerprint,
            &state.secrets_fingerprint,
        )?;
        let target_matches = config_pair_matches_state(
            config_path,
            secrets_path,
            &pending.config_fingerprint,
            &pending.secrets_fingerprint,
        )?;
        if target_matches {
            state.config_generation = pending.generation;
            state.config_fingerprint = pending.config_fingerprint;
            state.secrets_fingerprint = pending.secrets_fingerprint;
        } else if !committed_matches {
            let config_backup = read_optional_bytes(&config_rollback_path(config_path))?;
            let secrets_backup = read_optional_bytes(&config_rollback_path(secrets_path))?;
            if state.config_fingerprint.is_some() && config_backup.is_none() {
                return Err("Config transaction rollback file is missing".to_string());
            }
            if state.secrets_fingerprint.is_some() && secrets_backup.is_none() {
                return Err("Secrets transaction rollback file is missing".to_string());
            }
            restore_optional_file(config_path, config_backup.as_deref(), false)?;
            restore_optional_file(secrets_path, secrets_backup.as_deref(), true)?;
            if !config_pair_matches_state(
                config_path,
                secrets_path,
                &state.config_fingerprint,
                &state.secrets_fingerprint,
            )? {
                return Err("Config transaction rollback verification failed".to_string());
            }
        }
        state.pending_config = None;
        write_config_credential_state_file(&state_path, &state)?;
        cleanup_config_rollback_files(config_path, secrets_path);
    }

    if !config_pair_matches_state(
        config_path,
        secrets_path,
        &state.config_fingerprint,
        &state.secrets_fingerprint,
    )? {
        return Err("Config files do not match their committed generation".to_string());
    }
    cleanup_config_rollback_files(config_path, secrets_path);
    Ok(Some(state))
}

fn read_config_files_verified_unlocked(
    config_path: &Path,
    secrets_path: &Path,
) -> Result<AppConfigToml, String> {
    recover_config_publication_unlocked(config_path, secrets_path)?;
    read_config_files_unlocked(config_path, secrets_path)
}

fn read_config_files_verified(
    config_path: &Path,
    secrets_path: &Path,
) -> Result<AppConfigToml, String> {
    let _credential_guard = lock_dropbox_credential_state()?;
    read_config_files_verified_unlocked(config_path, secrets_path)
}

fn rollback_config_publication(
    config_path: &Path,
    secrets_path: &Path,
    previous_config: Option<&[u8]>,
    previous_secrets: Option<&[u8]>,
    state_path: &Path,
) -> Result<(), String> {
    restore_optional_file(config_path, previous_config, false)?;
    restore_optional_file(secrets_path, previous_secrets, true)?;
    let mut state = read_config_credential_state_file(state_path)?
        .ok_or_else(|| "Config credential state is missing during rollback".to_string())?;
    state.config_generation = state
        .config_generation
        .checked_add(1)
        .ok_or_else(|| "Config generation overflowed".to_string())?;
    state.config_fingerprint = previous_config.map(fingerprint_bytes);
    state.secrets_fingerprint = previous_secrets.map(fingerprint_bytes);
    state.pending_config = None;
    write_config_credential_state_file(state_path, &state)?;
    if !config_pair_matches_state(
        config_path,
        secrets_path,
        &state.config_fingerprint,
        &state.secrets_fingerprint,
    )? {
        return Err("Config rollback read-back verification failed".to_string());
    }
    cleanup_config_rollback_files(config_path, secrets_path);
    Ok(())
}

fn publish_config_pair_unlocked<AfterStage>(
    config_path: &Path,
    secrets_path: &Path,
    public_content: &str,
    secrets_content: Option<&str>,
    mut after_stage: AfterStage,
) -> Result<(), String>
where
    AfterStage: FnMut(ConfigPublicationStage) -> Result<(), String>,
{
    let state_path = config_credential_state_path_from_secrets_path(secrets_path);
    let recovered_state = recover_config_publication_unlocked(config_path, secrets_path)?;
    let previous_config = read_optional_bytes(config_path)?;
    let previous_secrets = read_optional_bytes(secrets_path)?;
    restore_optional_file(
        &config_rollback_path(config_path),
        previous_config.as_deref(),
        true,
    )?;
    restore_optional_file(
        &config_rollback_path(secrets_path),
        previous_secrets.as_deref(),
        true,
    )?;

    let mut state = recovered_state.unwrap_or(ConfigCredentialStateFile::from_current_files(
        config_path,
        secrets_path,
    )?);
    let next_generation = state
        .config_generation
        .checked_add(1)
        .ok_or_else(|| "Config generation overflowed".to_string())?;
    state.pending_config = Some(ConfigPublicationPending {
        generation: next_generation,
        config_fingerprint: Some(fingerprint_bytes(public_content.as_bytes())),
        secrets_fingerprint: secrets_content.map(|content| fingerprint_bytes(content.as_bytes())),
    });
    write_config_credential_state_file(&state_path, &state)?;

    let publication = (|| -> Result<(), String> {
        after_stage(ConfigPublicationStage::PendingState)?;
        write_atomic_text(config_path, public_content, false)?;
        after_stage(ConfigPublicationStage::PublicConfig)?;
        if let Some(content) = secrets_content {
            write_atomic_text(secrets_path, content, true)?;
        } else {
            remove_file_durably(secrets_path)?;
        }
        after_stage(ConfigPublicationStage::SecretConfig)?;

        let pending = state
            .pending_config
            .as_ref()
            .expect("pending config publication exists");
        if !config_pair_matches_state(
            config_path,
            secrets_path,
            &pending.config_fingerprint,
            &pending.secrets_fingerprint,
        )? {
            return Err("Config publication failed durable read-back verification".to_string());
        }
        after_stage(ConfigPublicationStage::ReadBack)?;
        state.config_generation = pending.generation;
        state.config_fingerprint = pending.config_fingerprint.clone();
        state.secrets_fingerprint = pending.secrets_fingerprint.clone();
        state.pending_config = None;
        write_config_credential_state_file(&state_path, &state)?;
        after_stage(ConfigPublicationStage::CommittedState)?;
        cleanup_config_rollback_files(config_path, secrets_path);
        Ok(())
    })();

    if let Err(error) = publication {
        if let Err(rollback_error) = rollback_config_publication(
            config_path,
            secrets_path,
            previous_config.as_deref(),
            previous_secrets.as_deref(),
            &state_path,
        ) {
            return Err(format!(
                "{error}; rollback failed and credentials remain fail-closed: {rollback_error}"
            ));
        }
        return Err(error);
    }
    Ok(())
}

// Poison-recovering (I1): a panic while holding this must not permanently
// block every future config read/write. Matches the codebase's established
// recovery shape (local_api.rs's LocalApiServerState lock) rather than
// failing the caller — the protected data is a Mutex<()>, so "recovering"
// just means proceeding; there's no partially-mutated state to distrust.
fn lock_dropbox_credential_state() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    Ok(DROPBOX_CREDENTIAL_STATE_MUTEX
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()))
}

// Distinct from lock_dropbox_credential_state: that one guards individual
// file operations for microseconds each (read_config/write_config_files each
// take-and-release it internally). This one is held by a CALLER across a
// whole read-config-mutate-write span (e.g. write_local_api_config,
// clear_sync_path, set_desktop_rendering_config, and B3's config.rs setters)
// — those commands now run off the main thread, and each's
// read_config()+write_config_files() pair used to be serialized only by
// accident, by never actually running concurrently. Never call this while
// already holding it — that's the only illegal nesting.
//
// LOCK ORDERING: this mutex may always be taken around a call to
// read_config()/write_config_files()/read_bound_credential()/
// update_bound_credential()/read_dropbox_credential_state()/
// update_dropbox_credential_state()/read_sync_backend_publication_state()/
// publish_sync_backend_paths_with()/read_sync_configuration_pair() — all of
// those internally take-and-release lock_dropbox_credential_state, a
// different mutex, so this one nests around them safely (including through
// read_config()'s own conditional migrate_legacy_secrets() call, which
// itself calls write_config_files() — nesting the SAME mutex there would
// deadlock, which is why this is a second, distinct lock rather than reusing
// lock_dropbox_credential_state). Never acquire lock_dropbox_credential_state
// directly and then try to also take this one inside that scope — always the
// other order (this one outermost, if both are needed).
fn config_read_modify_write_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

// Poison-recovering (I1) — same rationale as lock_dropbox_credential_state above.
pub(crate) fn lock_config_read_modify_write() -> Result<std::sync::MutexGuard<'static, ()>, String>
{
    Ok(config_read_modify_write_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()))
}

pub(crate) fn write_config_files(
    config_path: &Path,
    secrets_path: &Path,
    config: &AppConfigToml,
) -> Result<(), String> {
    let _credential_guard = lock_dropbox_credential_state()?;
    write_config_files_unlocked(config_path, secrets_path, config)
}

#[cfg(test)]
fn write_config_files_with_stage_hook<AfterStage>(
    config_path: &Path,
    secrets_path: &Path,
    config: &AppConfigToml,
    after_stage: AfterStage,
) -> Result<(), String>
where
    AfterStage: FnMut(ConfigPublicationStage) -> Result<(), String>,
{
    let _credential_guard = lock_dropbox_credential_state()?;
    write_config_files_with_backend_authority_unlocked_with_hook(
        config_path,
        secrets_path,
        config,
        true,
        after_stage,
    )
}

fn write_config_files_unlocked(
    config_path: &Path,
    secrets_path: &Path,
    config: &AppConfigToml,
) -> Result<(), String> {
    write_config_files_with_backend_authority_unlocked(config_path, secrets_path, config, true)
}

fn write_config_files_with_backend_authority_unlocked(
    config_path: &Path,
    secrets_path: &Path,
    config: &AppConfigToml,
    preserve_dedicated_backend: bool,
) -> Result<(), String> {
    write_config_files_with_backend_authority_unlocked_with_hook(
        config_path,
        secrets_path,
        config,
        preserve_dedicated_backend,
        |_| Ok(()),
    )
}

fn write_config_files_with_backend_authority_unlocked_with_hook<AfterStage>(
    config_path: &Path,
    secrets_path: &Path,
    config: &AppConfigToml,
    preserve_dedicated_backend: bool,
    after_stage: AfterStage,
) -> Result<(), String>
where
    AfterStage: FnMut(ConfigPublicationStage) -> Result<(), String>,
{
    // These two files form one logical configuration document. Validate both
    // before mutating either so a corrupt or unreadable secrets file cannot be
    // interpreted as an empty split and deleted after config.toml is changed.
    preflight_existing_config_toml(config_path)?;
    preflight_existing_config_toml(secrets_path)?;
    let mut sanitized = config.clone();
    let state_path = dropbox_credential_state_path_from_secrets_path(secrets_path);
    if let Some(state) = read_dropbox_credential_state_file(&state_path)? {
        // Once the dedicated state file exists it is the sole authority for
        // Dropbox fallback bytes. A stale whole-config snapshot must never
        // write either legacy field back into secrets.toml.
        sanitized.dropbox_tokens = None;
        sanitized.dropbox_promotion_journal = None;
        if preserve_dedicated_backend {
            // Generic setters carry a whole AppConfigToml snapshot even though
            // they own only one field. Preserve the dedicated backend marker so
            // a snapshot captured before an atomic backend publication cannot
            // clobber the newly committed raw backend after the lock is released.
            let marker = normalize_backend(state.sync_backend_marker.trim())
                .expect("validated Dropbox backend marker");
            sanitized.sync_backend = Some(marker.to_string());
        }
    }
    let (public_config, secrets_config) = split_config_for_secrets(&sanitized);
    let public_content =
        serialize_config_toml_with_header(config_path, &public_config, "# Mindwtr desktop config")?;
    let secrets_content = if config_has_values(&secrets_config) {
        Some(serialize_config_toml_with_header(
            secrets_path,
            &secrets_config,
            "# Mindwtr desktop secrets",
        )?)
    } else {
        None
    };
    publish_config_pair_unlocked(
        config_path,
        secrets_path,
        &public_content,
        secrets_content.as_deref(),
        after_stage,
    )
}

fn endpoint_fingerprint(service: CredentialService, config: &AppConfigToml) -> String {
    let encoded = serde_json::to_vec(&service.endpoint_identity(config))
        .expect("credential endpoint identity serializes infallibly");
    fingerprint_bytes(&encoded)
}

fn credential_fingerprint(secret: Option<&str>) -> String {
    let mut digest = Sha256::new();
    match secret {
        Some(secret) => {
            digest.update(b"mindwtr-credential-present\0");
            digest.update(secret.as_bytes());
        }
        None => digest.update(b"mindwtr-credential-absent\0"),
    }
    format!("{:x}", digest.finalize())
}

fn load_config_credential_state_unlocked(
    config_path: &Path,
    secrets_path: &Path,
) -> Result<ConfigCredentialStateFile, String> {
    let state_path = config_credential_state_path_from_secrets_path(secrets_path);
    if let Some(state) = recover_config_publication_unlocked(config_path, secrets_path)? {
        return Ok(state);
    }
    let state = ConfigCredentialStateFile::from_current_files(config_path, secrets_path)?;
    write_config_credential_state_file(&state_path, &state)?;
    Ok(state)
}

fn select_secret_for_fingerprint(
    expected_fingerprint: &str,
    keyring: Result<Option<String>, String>,
    fallback: Option<String>,
) -> Result<Option<String>, String> {
    if expected_fingerprint == credential_fingerprint(None) {
        return Ok(None);
    }
    if let Ok(Some(secret)) = &keyring {
        if credential_fingerprint(Some(secret)) == expected_fingerprint {
            return Ok(Some(secret.clone()));
        }
    }
    if let Some(secret) = fallback {
        if credential_fingerprint(Some(&secret)) == expected_fingerprint {
            return Ok(Some(secret));
        }
    }
    Err("Credential binding does not match any available secret authority".to_string())
}

fn select_exact_secret_for_fingerprint(
    expected_fingerprint: &str,
    keyring: &Result<Option<String>, String>,
    fallback: Option<String>,
) -> Result<Option<String>, String> {
    if expected_fingerprint == credential_fingerprint(None) {
        return match (keyring, fallback) {
            (Ok(None), None) => Ok(None),
            _ => Err("Pending credential authorities do not prove absence".to_string()),
        };
    }

    let mut matched: Option<String> = None;
    if let Ok(Some(secret)) = keyring {
        if credential_fingerprint(Some(secret)) != expected_fingerprint {
            return Err("Pending keyring credential does not match its target".to_string());
        }
        matched = Some(secret.clone());
    }
    if let Some(secret) = fallback {
        if credential_fingerprint(Some(&secret)) != expected_fingerprint {
            return Err("Pending fallback credential does not match its target".to_string());
        }
        matched = Some(secret);
    }
    matched
        .map(Some)
        .ok_or_else(|| "Pending credential target has no exact available authority".to_string())
}

enum PendingCredentialResolution {
    NotApplicable,
    Resolved(Option<String>),
}

fn next_credential_generation_for_service(
    state: &ConfigCredentialStateFile,
    service: CredentialService,
) -> Result<u64, String> {
    state
        .bindings
        .get(service.state_key())
        .map(|binding| binding.generation)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| format!("{} credential generation overflowed", service.state_key()))
}

fn reconcile_pending_credential_unlocked(
    state_path: &Path,
    state: &mut ConfigCredentialStateFile,
    config: &AppConfigToml,
    service: CredentialService,
    keyring: &Result<Option<String>, String>,
) -> Result<PendingCredentialResolution, String> {
    let Some(pending) = state.pending_credential.clone() else {
        return Ok(PendingCredentialResolution::NotApplicable);
    };
    if pending.service != service.state_key() {
        return Ok(PendingCredentialResolution::NotApplicable);
    }
    CredentialService::from_state_key(&pending.service)
        .ok_or_else(|| "Credential pending marker names an invalid service".to_string())?;

    let service_key = service.state_key();
    let binding = state
        .bindings
        .get(service_key)
        .cloned()
        .ok_or_else(|| format!("{service_key} pending credential has no committed binding"))?;
    let current_endpoint_fingerprint = endpoint_fingerprint(service, config);
    let fallback = service.fallback(config).map(str::to_string);

    if binding.endpoint_fingerprint == current_endpoint_fingerprint {
        if let Ok(secret) = select_exact_secret_for_fingerprint(
            &binding.credential_fingerprint,
            keyring,
            fallback.clone(),
        ) {
            state.pending_credential = None;
            write_config_credential_state_file(state_path, state)?;
            return Ok(PendingCredentialResolution::Resolved(secret));
        }
    }

    let expected_generation = next_credential_generation_for_service(state, service)?;
    if pending.generation == expected_generation
        && pending.endpoint_fingerprint == current_endpoint_fingerprint
    {
        if let Ok(secret) =
            select_exact_secret_for_fingerprint(&pending.credential_fingerprint, keyring, fallback)
        {
            state.credential_generation = pending.generation;
            state.bindings.insert(
                service_key.to_string(),
                CredentialBinding {
                    generation: pending.generation,
                    endpoint_fingerprint: pending.endpoint_fingerprint,
                    credential_fingerprint: pending.credential_fingerprint,
                },
            );
            state.pending_credential = None;
            write_config_credential_state_file(state_path, state)?;
            return Ok(PendingCredentialResolution::Resolved(secret));
        }
    }

    Err(format!(
        "{service_key} credential update was interrupted and remains fail-closed"
    ))
}

fn resolve_bound_credential_unlocked(
    config_path: &Path,
    secrets_path: &Path,
    config: &AppConfigToml,
    service: CredentialService,
    keyring: Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    let state_path = config_credential_state_path_from_secrets_path(secrets_path);
    let mut state = load_config_credential_state_unlocked(config_path, secrets_path)?;
    if let PendingCredentialResolution::Resolved(secret) =
        reconcile_pending_credential_unlocked(&state_path, &mut state, config, service, &keyring)?
    {
        return Ok(secret);
    }
    let service_key = service.state_key();
    let current_endpoint_fingerprint = endpoint_fingerprint(service, config);
    if let Some(binding) = state.bindings.get(service_key) {
        if binding.endpoint_fingerprint != current_endpoint_fingerprint {
            return Err(format!(
                "{} endpoint does not match its committed credential binding",
                service_key
            ));
        }
        return select_secret_for_fingerprint(
            &binding.credential_fingerprint,
            keyring,
            service.fallback(config).map(str::to_string),
        );
    }

    let fallback = service.fallback(config).map(str::to_string);
    let effective = match keyring {
        Ok(Some(secret)) => Some(secret),
        Ok(None) => fallback,
        Err(_) if fallback.is_some() => fallback,
        Err(_) => {
            return Err(format!(
                "{} credential authority is unavailable",
                service_key
            ))
        }
    };
    let service_generation = next_credential_generation_for_service(&state, service)?;
    state.credential_generation = state.credential_generation.max(service_generation);
    state.bindings.insert(
        service_key.to_string(),
        CredentialBinding {
            generation: service_generation,
            endpoint_fingerprint: current_endpoint_fingerprint,
            credential_fingerprint: credential_fingerprint(effective.as_deref()),
        },
    );
    write_config_credential_state_file(&state_path, &state)?;
    Ok(effective)
}

fn resolve_sync_snapshot_secret_unlocked(
    config_path: &Path,
    secrets_path: &Path,
    config: &AppConfigToml,
    service: CredentialService,
    keyring: Result<Option<String>, String>,
) -> Result<SyncSnapshotSecret, String> {
    match resolve_bound_credential_unlocked(config_path, secrets_path, config, service, keyring) {
        Ok(secret) => Ok(SyncSnapshotSecret::Known(secret.unwrap_or_default())),
        Err(error)
            if error
                == format!(
                    "{} credential authority is unavailable",
                    service.state_key()
                )
                || error == "Credential binding does not match any available secret authority" =>
        {
            Ok(SyncSnapshotSecret::Opaque)
        }
        Err(error) => Err(error),
    }
}

fn read_bound_credential_paths_with<ReadSecret>(
    config_path: &Path,
    secrets_path: &Path,
    service: CredentialService,
    mut read_secret: ReadSecret,
) -> Result<(AppConfigToml, Option<String>), String>
where
    ReadSecret: FnMut() -> Result<Option<String>, String>,
{
    let _credential_guard = lock_dropbox_credential_state()?;
    let config = read_config_files_verified_unlocked(config_path, secrets_path)?;
    let secret = resolve_bound_credential_unlocked(
        config_path,
        secrets_path,
        &config,
        service,
        read_secret(),
    )?;
    Ok((config, secret))
}

fn restore_credential_transaction<WriteSecret>(
    config_path: &Path,
    secrets_path: &Path,
    previous_config: &AppConfigToml,
    previous_keyring: &Result<Option<String>, String>,
    secret_store_changed: bool,
    previous_credential_generation: u64,
    previous_bindings: &BTreeMap<String, CredentialBinding>,
    write_secret: &mut WriteSecret,
) -> Result<(), String>
where
    WriteSecret: FnMut(Option<String>) -> Result<(), String>,
{
    if secret_store_changed {
        let previous = previous_keyring.as_ref().map_err(|_| {
            "Previous keyring value was opaque, so rollback cannot be verified".to_string()
        })?;
        write_secret(previous.clone())?;
    }
    write_config_files_unlocked(config_path, secrets_path, previous_config)?;
    let state_path = config_credential_state_path_from_secrets_path(secrets_path);
    let mut state = load_config_credential_state_unlocked(config_path, secrets_path)?;
    state.credential_generation = previous_credential_generation;
    state.bindings = previous_bindings.clone();
    state.pending_credential = None;
    write_config_credential_state_file(&state_path, &state)
}

fn update_bound_credential_paths_with<MutateConfig, ReadSecret, WriteSecret, AfterStage>(
    config_path: &Path,
    secrets_path: &Path,
    service: CredentialService,
    secret_update: CredentialSecretUpdate,
    mutate_config: MutateConfig,
    mut read_secret: ReadSecret,
    mut write_secret: WriteSecret,
    mut after_stage: AfterStage,
) -> Result<AppConfigToml, String>
where
    MutateConfig: FnOnce(&mut AppConfigToml),
    ReadSecret: FnMut() -> Result<Option<String>, String>,
    WriteSecret: FnMut(Option<String>) -> Result<(), String>,
    AfterStage: FnMut(CredentialPublicationStage) -> Result<(), String>,
{
    let _credential_guard = lock_dropbox_credential_state()?;
    let previous_config = read_config_files_verified_unlocked(config_path, secrets_path)?;
    let previous_keyring = read_secret();
    let previous_effective_result = resolve_bound_credential_unlocked(
        config_path,
        secrets_path,
        &previous_config,
        service,
        previous_keyring.clone(),
    );
    let previous_effective = match previous_effective_result {
        Ok(secret) => secret,
        Err(_) if matches!(&secret_update, CredentialSecretUpdate::Replace(_)) => None,
        Err(error) => return Err(error),
    };
    let previous_state = load_config_credential_state_unlocked(config_path, secrets_path)?;
    if let Some(pending) = &previous_state.pending_credential {
        if pending.service != service.state_key() {
            return Err(format!(
                "{} credential update is still pending",
                pending.service
            ));
        }
    }
    let mut next_config = previous_config.clone();
    mutate_config(&mut next_config);
    let next_secret = match &secret_update {
        CredentialSecretUpdate::Keep => previous_effective,
        CredentialSecretUpdate::Replace(secret) => secret.clone(),
    };
    let target_endpoint_fingerprint = endpoint_fingerprint(service, &next_config);
    let target_credential_fingerprint = credential_fingerprint(next_secret.as_deref());
    let state_path = config_credential_state_path_from_secrets_path(secrets_path);
    let mut state = previous_state.clone();
    let next_generation = next_credential_generation_for_service(&state, service)?;
    state.pending_credential = Some(CredentialBindingPending {
        service: service.state_key().to_string(),
        generation: next_generation,
        endpoint_fingerprint: target_endpoint_fingerprint.clone(),
        credential_fingerprint: target_credential_fingerprint.clone(),
    });
    write_config_credential_state_file(&state_path, &state)?;

    let mut secret_store_changed = false;
    let transaction = (|| -> Result<AppConfigToml, String> {
        after_stage(CredentialPublicationStage::PendingState)?;
        if matches!(&secret_update, CredentialSecretUpdate::Replace(_)) {
            match write_secret(next_secret.clone()) {
                Ok(()) => {
                    secret_store_changed = true;
                    service.set_fallback(&mut next_config, None);
                }
                Err(_) => service.set_fallback(&mut next_config, next_secret.clone()),
            }
        }
        after_stage(CredentialPublicationStage::SecretStore)?;
        write_config_files_unlocked(config_path, secrets_path, &next_config)?;
        after_stage(CredentialPublicationStage::ConfigPair)?;

        let readback_config = read_config_files_verified_unlocked(config_path, secrets_path)?;
        if endpoint_fingerprint(service, &readback_config) != target_endpoint_fingerprint {
            return Err("Credential endpoint failed durable read-back verification".to_string());
        }
        select_secret_for_fingerprint(
            &target_credential_fingerprint,
            read_secret(),
            service.fallback(&readback_config).map(str::to_string),
        )?;
        after_stage(CredentialPublicationStage::ReadBack)?;

        let mut committed_state = load_config_credential_state_unlocked(config_path, secrets_path)?;
        let pending = committed_state
            .pending_credential
            .as_ref()
            .ok_or_else(|| "Credential pending marker disappeared before commit".to_string())?;
        if pending.service != service.state_key()
            || pending.generation != next_generation
            || pending.endpoint_fingerprint != target_endpoint_fingerprint
            || pending.credential_fingerprint != target_credential_fingerprint
        {
            return Err("Credential pending marker changed before commit".to_string());
        }
        committed_state.credential_generation =
            committed_state.credential_generation.max(next_generation);
        committed_state.bindings.insert(
            service.state_key().to_string(),
            CredentialBinding {
                generation: next_generation,
                endpoint_fingerprint: target_endpoint_fingerprint,
                credential_fingerprint: target_credential_fingerprint,
            },
        );
        committed_state.pending_credential = None;
        write_config_credential_state_file(&state_path, &committed_state)?;
        after_stage(CredentialPublicationStage::CommittedState)?;
        Ok(readback_config)
    })();

    match transaction {
        Ok(config) => Ok(config),
        Err(error) => {
            if let Err(rollback_error) = restore_credential_transaction(
                config_path,
                secrets_path,
                &previous_config,
                &previous_keyring,
                secret_store_changed,
                previous_state.credential_generation,
                &previous_state.bindings,
                &mut write_secret,
            ) {
                return Err(format!(
                    "{error}; rollback failed and credentials remain fail-closed: {rollback_error}"
                ));
            }
            Err(error)
        }
    }
}

pub(crate) fn read_bound_credential(
    app: &tauri::AppHandle,
    service: CredentialService,
) -> Result<(AppConfigToml, Option<String>), String> {
    read_bound_credential_paths_with(
        &get_config_path(app),
        &get_secrets_path(app),
        service,
        || get_keyring_secret(app, service.keyring_key()),
    )
}

pub(crate) fn update_bound_credential<MutateConfig>(
    app: &tauri::AppHandle,
    service: CredentialService,
    secret_update: CredentialSecretUpdate,
    mutate_config: MutateConfig,
) -> Result<AppConfigToml, String>
where
    MutateConfig: FnOnce(&mut AppConfigToml),
{
    update_bound_credential_paths_with(
        &get_config_path(app),
        &get_secrets_path(app),
        service,
        secret_update,
        mutate_config,
        || get_keyring_secret(app, service.keyring_key()),
        |secret| set_keyring_secret(app, service.keyring_key(), secret),
        |_| Ok(()),
    )
}

fn read_config_toml_optional_strict(path: &Path) -> Result<AppConfigToml, String> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            if raw.trim().is_empty() {
                Ok(AppConfigToml::default())
            } else {
                toml::from_str(&raw).map_err(|_| {
                    format!(
                        "Failed to inspect {} while migrating Dropbox credential state",
                        path.display()
                    )
                })
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(AppConfigToml::default()),
        Err(_) => Err(format!(
            "Failed to inspect {} while migrating Dropbox credential state",
            path.display()
        )),
    }
}

fn read_config_files_unlocked(
    config_path: &Path,
    secrets_path: &Path,
) -> Result<AppConfigToml, String> {
    let mut config = read_config_toml_optional_strict(config_path)?;
    let secrets = read_config_toml_optional_strict(secrets_path)?;
    merge_config(&mut config, secrets);
    if dropbox_credential_state_path_from_secrets_path(secrets_path).exists() {
        config.dropbox_tokens = None;
        config.dropbox_promotion_journal = None;
    }
    Ok(config)
}

fn load_or_migrate_dropbox_credential_state_unlocked(
    app: &tauri::AppHandle,
) -> Result<DropboxCredentialStateFile, String> {
    let state_path = get_dropbox_credential_state_path(app);
    load_or_migrate_dropbox_credential_state_paths_unlocked(
        &get_config_path(app),
        &get_secrets_path(app),
        &state_path,
    )
}

fn load_or_migrate_dropbox_credential_state_paths_unlocked(
    config_path: &Path,
    secrets_path: &Path,
    state_path: &Path,
) -> Result<DropboxCredentialStateFile, String> {
    // Dropbox's dedicated marker is layered on top of the public/private
    // config pair. Recover that lower-level transaction before either reading
    // the raw backend or deriving legacy state from it.
    recover_config_publication_unlocked(config_path, secrets_path)?;
    if let Some(state) = read_dropbox_credential_state_file(state_path)? {
        return Ok(state);
    }

    let mut config = read_config_toml_optional_strict(config_path)?;
    let secrets = read_config_toml_optional_strict(secrets_path)?;
    merge_config(&mut config, secrets);

    let backend = config
        .sync_backend
        .as_deref()
        .map(str::trim)
        .and_then(normalize_backend)
        .unwrap_or("off")
        .to_string();
    let state = DropboxCredentialStateFile {
        token_fallback: config.dropbox_tokens.take(),
        promotion_journal: config.dropbox_promotion_journal.take(),
        sync_backend_marker: backend,
        ..DropboxCredentialStateFile::default()
    };
    // Publish the dedicated authority before removing either legacy field.
    // A crash at this point leaves duplicate bytes, but state-file existence
    // makes them permanently non-authoritative on the next read.
    write_dropbox_credential_state_file(state_path, &state)?;
    write_config_files_unlocked(config_path, secrets_path, &config)?;
    Ok(state)
}

pub(crate) fn read_dropbox_credential_state(
    app: &tauri::AppHandle,
) -> Result<DropboxCredentialStateFile, String> {
    let _credential_guard = lock_dropbox_credential_state()?;
    load_or_migrate_dropbox_credential_state_unlocked(app)
}

fn update_dropbox_credential_state_paths_unlocked<F>(
    config_path: &Path,
    secrets_path: &Path,
    state_path: &Path,
    update: F,
) -> Result<DropboxCredentialStateFile, String>
where
    F: FnOnce(&mut DropboxCredentialStateFile) -> Result<(), String>,
{
    let mut state = load_or_migrate_dropbox_credential_state_paths_unlocked(
        config_path,
        secrets_path,
        state_path,
    )?;
    update(&mut state)?;
    state.generation = state
        .generation
        .checked_add(1)
        .ok_or_else(|| "Dropbox credential state generation overflowed".to_string())?;
    write_dropbox_credential_state_file(state_path, &state)?;
    Ok(state)
}

fn update_dropbox_credential_state_unlocked<F>(
    app: &tauri::AppHandle,
    update: F,
) -> Result<DropboxCredentialStateFile, String>
where
    F: FnOnce(&mut DropboxCredentialStateFile) -> Result<(), String>,
{
    update_dropbox_credential_state_paths_unlocked(
        &get_config_path(app),
        &get_secrets_path(app),
        &get_dropbox_credential_state_path(app),
        update,
    )
}

pub(crate) fn update_dropbox_credential_state<F>(
    app: &tauri::AppHandle,
    update: F,
) -> Result<DropboxCredentialStateFile, String>
where
    F: FnOnce(&mut DropboxCredentialStateFile) -> Result<(), String>,
{
    let _credential_guard = lock_dropbox_credential_state()?;
    update_dropbox_credential_state_unlocked(app, update)
}

fn migrate_legacy_secrets(app: &tauri::AppHandle, config: &mut AppConfigToml) {
    if !keyring_enabled() {
        return;
    }
    let mut migrated = false;
    if let Some(value) = config.webdav_password.clone() {
        if set_keyring_secret(app, KEYRING_WEB_DAV_PASSWORD, Some(value)).is_ok() {
            config.webdav_password = None;
            migrated = true;
        }
    }
    if let Some(value) = config.cloud_token.clone() {
        if set_keyring_secret(app, KEYRING_CLOUD_TOKEN, Some(value)).is_ok() {
            config.cloud_token = None;
            migrated = true;
        }
    }
    if let Some(value) = config.dropbox_tokens.clone() {
        if set_keyring_secret(app, KEYRING_DROPBOX_TOKENS, Some(value)).is_ok() {
            config.dropbox_tokens = None;
            migrated = true;
        }
    }
    if let Some(value) = config.ai_key_openai.clone() {
        if set_keyring_secret(app, KEYRING_AI_OPENAI, Some(value)).is_ok() {
            config.ai_key_openai = None;
            migrated = true;
        }
    }
    if let Some(value) = config.ai_key_anthropic.clone() {
        if set_keyring_secret(app, KEYRING_AI_ANTHROPIC, Some(value)).is_ok() {
            config.ai_key_anthropic = None;
            migrated = true;
        }
    }
    if let Some(value) = config.ai_key_gemini.clone() {
        if set_keyring_secret(app, KEYRING_AI_GEMINI, Some(value)).is_ok() {
            config.ai_key_gemini = None;
            migrated = true;
        }
    }
    if let Some(value) = config.email_capture_password.clone() {
        if set_keyring_secret(app, KEYRING_EMAIL_CAPTURE_PASSWORD, Some(value)).is_ok() {
            config.email_capture_password = None;
            migrated = true;
        }
    }
    if migrated {
        let _ = write_config_files(&get_config_path(app), &get_secrets_path(app), config);
    }
}

fn keyring_service(app: &tauri::AppHandle) -> String {
    format!("{}:secrets", app.config().identifier)
}

fn keyring_entry(app: &tauri::AppHandle, key: &str) -> Result<Entry, String> {
    Entry::new(&keyring_service(app), key).map_err(|e| e.to_string())
}

pub(crate) fn get_keyring_secret(
    app: &tauri::AppHandle,
    key: &str,
) -> Result<Option<String>, String> {
    if !keyring_enabled() {
        return Ok(None);
    }
    let entry = keyring_entry(app, key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn set_keyring_secret(
    app: &tauri::AppHandle,
    key: &str,
    value: Option<String>,
) -> Result<(), String> {
    if !keyring_enabled() {
        return Err("Portable mode stores secrets in secrets.toml".to_string());
    }
    let entry = keyring_entry(app, key)?;
    match value {
        Some(value) if !value.trim().is_empty() => {
            entry.set_password(value.trim()).map_err(|e| e.to_string())
        }
        _ => match entry.delete_password() {
            Ok(_) => Ok(()),
            Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

// Held across the whole read+possible-migrate-write (B3): the legacy-key
// migration branch below writes config.toml, and read_config/write_config_files
// only lock/unlock lock_dropbox_credential_state briefly on their own — a
// different, DISTINCT mutex from this one (nesting the same mutex here would
// deadlock the moment read_config's own migrate_legacy_secrets fires; see
// lock_config_read_modify_write's definition).
#[tauri::command(async)]
pub(crate) fn get_ai_key(app: tauri::AppHandle, provider: String) -> Option<String> {
    let _config_guard = lock_config_read_modify_write().ok()?;
    let mut config = read_config(&app);
    let (key_name, legacy_value) = match provider.as_str() {
        "openai" => (KEYRING_AI_OPENAI, config.ai_key_openai.clone()),
        "anthropic" => (KEYRING_AI_ANTHROPIC, config.ai_key_anthropic.clone()),
        "gemini" => (KEYRING_AI_GEMINI, config.ai_key_gemini.clone()),
        _ => return None,
    };
    if let Ok(Some(value)) = get_keyring_secret(&app, key_name) {
        return Some(value);
    }
    if let Some(legacy) = legacy_value {
        if set_keyring_secret(&app, key_name, Some(legacy.clone())).is_ok() {
            match provider.as_str() {
                "openai" => config.ai_key_openai = None,
                "anthropic" => config.ai_key_anthropic = None,
                "gemini" => config.ai_key_gemini = None,
                _ => {}
            }
            let _ = write_config_files(&get_config_path(&app), &get_secrets_path(&app), &config);
        }
        return Some(legacy);
    }
    None
}

// Held across the whole read+mutate+write (B3) — see lock_config_read_modify_write.
#[tauri::command(async)]
pub(crate) fn set_ai_key(
    app: tauri::AppHandle,
    provider: String,
    value: Option<String>,
) -> Result<(), String> {
    let _config_guard = lock_config_read_modify_write()?;
    let next_value = value.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let key_name = match provider.as_str() {
        "openai" => KEYRING_AI_OPENAI,
        "anthropic" => KEYRING_AI_ANTHROPIC,
        "gemini" => KEYRING_AI_GEMINI,
        _ => return Ok(()),
    };
    match set_keyring_secret(&app, key_name, next_value.clone()) {
        Ok(_) => {
            let mut config = read_config(&app);
            match provider.as_str() {
                "openai" => config.ai_key_openai = None,
                "anthropic" => config.ai_key_anthropic = None,
                "gemini" => config.ai_key_gemini = None,
                _ => {}
            }
            let _ = write_config_files(&get_config_path(&app), &get_secrets_path(&app), &config);
            Ok(())
        }
        Err(_) => {
            let mut config = read_config(&app);
            let should_emit_warning = next_value.is_some();
            match provider.as_str() {
                "openai" => config.ai_key_openai = next_value,
                "anthropic" => config.ai_key_anthropic = next_value,
                "gemini" => config.ai_key_gemini = next_value,
                _ => {}
            }
            let label = match provider.as_str() {
                "openai" => "OpenAI API key",
                "anthropic" => "Anthropic API key",
                "gemini" => "Gemini API key",
                _ => "Secret",
            };
            if should_emit_warning {
                emit_keyring_fallback_warning(&app, label);
            }
            write_config_files(&get_config_path(&app), &get_secrets_path(&app), &config)
        }
    }
}

fn normalize_backend(value: &str) -> Option<&str> {
    match value {
        "off" | "file" | "webdav" | "cloud" | "cloudkit" => Some(value),
        _ => None,
    }
}

fn normalize_sync_cloud_provider(value: &str) -> Option<&str> {
    match value {
        "selfhosted" | "dropbox" => Some(value),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
enum SyncSnapshotSecret {
    Known(String),
    Opaque,
}

impl SyncSnapshotSecret {
    fn value(&self) -> Option<&str> {
        match self {
            Self::Known(value) => Some(value),
            Self::Opaque => None,
        }
    }

    fn authority(&self) -> &'static str {
        match self {
            Self::Known(_) => "known",
            Self::Opaque => "opaque",
        }
    }
}

fn sync_configuration_snapshot_value(
    config: &AppConfigToml,
    webdav_password: SyncSnapshotSecret,
    cloud_token: SyncSnapshotSecret,
    cloud_provider: &str,
    cloud_provider_authority: &str,
) -> Value {
    serde_json::json!({
        "backend": config
            .sync_backend
            .as_deref()
            .and_then(|value| normalize_backend(value.trim()))
            .unwrap_or("off"),
        // Use the raw stored path here. The normal getter validates and
        // canonicalizes the directory, which would lose a dormant path that is
        // temporarily unavailable precisely when rollback needs to preserve it.
        "syncPath": config.sync_path.clone().unwrap_or_default(),
        "webdav": {
            "url": config.webdav_url.clone().unwrap_or_default(),
            "username": config.webdav_username.clone().unwrap_or_default(),
            "password": webdav_password.value(),
            "passwordAuthority": webdav_password.authority(),
            "hasPassword": webdav_password.value().map(|value| !value.is_empty()),
            "allowInsecureHttp": config.webdav_allow_insecure_http.as_deref() == Some("true"),
            "allowWeakFingerprint": config.webdav_allow_weak_fingerprint.as_deref() != Some("false"),
        },
        "cloudProvider": cloud_provider,
        "cloudProviderAuthority": cloud_provider_authority,
        "cloud": {
            "url": config.cloud_url.clone().unwrap_or_default(),
            "token": cloud_token.value(),
            "tokenAuthority": cloud_token.authority(),
            "allowInsecureHttp": config.cloud_allow_insecure_http.as_deref() == Some("true"),
            "rememberToken": false,
        },
    })
}

#[cfg(test)]
fn sync_snapshot_secret_with(
    keyring: Result<Option<String>, String>,
    fallback: Result<Option<String>, String>,
) -> SyncSnapshotSecret {
    match (keyring, fallback) {
        (Ok(Some(secret)), _) | (Ok(None), Ok(Some(secret))) | (Err(_), Ok(Some(secret))) => {
            SyncSnapshotSecret::Known(secret)
        }
        (Ok(None), Ok(None)) => SyncSnapshotSecret::Known(String::new()),
        (Ok(None), Err(_)) | (Err(_), Ok(None)) | (Err(_), Err(_)) => SyncSnapshotSecret::Opaque,
    }
}

#[cfg(test)]
fn read_snapshot_config_paths(
    config_path: &Path,
    secrets_path: &Path,
) -> Result<
    (
        AppConfigToml,
        Result<Option<String>, String>,
        Result<Option<String>, String>,
    ),
    String,
> {
    let mut config = read_config_toml_optional_strict(config_path)?;
    let public_webdav_password = config.webdav_password.clone();
    let public_cloud_token = config.cloud_token.clone();
    let secrets = read_config_toml_optional_strict(secrets_path);
    match secrets {
        Ok(secrets) => {
            // Shipped pre-split builds could leave these fields in config.toml.
            // Prefer the private split when present, but retain the readable
            // public legacy value so an exact rollback snapshot does not erase
            // it merely because migration has not run yet.
            let webdav_password = Ok(secrets.webdav_password.clone().or(public_webdav_password));
            let cloud_token = Ok(secrets.cloud_token.clone().or(public_cloud_token));
            merge_config(&mut config, secrets);
            Ok((config, webdav_password, cloud_token))
        }
        Err(error) => Ok((config, Err(error.clone()), Err(error))),
    }
}

#[cfg(test)]
fn read_sync_configuration_pair_paths_with<AfterStateRead>(
    config_path: &Path,
    secrets_path: &Path,
    state_path: &Path,
    after_state_read: AfterStateRead,
) -> Result<
    (
        (
            AppConfigToml,
            Result<Option<String>, String>,
            Result<Option<String>, String>,
        ),
        DropboxCredentialStateFile,
    ),
    String,
>
where
    AfterStateRead: FnOnce(),
{
    let _credential_guard = lock_dropbox_credential_state()?;
    let (_, state) = read_sync_backend_publication_state_paths_unlocked_with(
        config_path,
        secrets_path,
        state_path,
        after_state_read,
    )?;
    let (mut config, webdav_fallback, cloud_fallback) =
        read_snapshot_config_paths(config_path, secrets_path)?;
    // The dedicated marker is the commit authority. Project it explicitly so
    // even a legacy secrets.toml containing a stray sync_backend field cannot
    // override the reconciled public value in the renderer snapshot.
    config.sync_backend = Some(
        normalize_backend(state.sync_backend_marker.trim())
            .expect("validated Dropbox backend marker")
            .to_string(),
    );
    let configs = (config, webdav_fallback, cloud_fallback);
    Ok((configs, state))
}

fn read_sync_configuration_pair(
    app: &tauri::AppHandle,
) -> Result<
    (
        AppConfigToml,
        SyncSnapshotSecret,
        SyncSnapshotSecret,
        DropboxCredentialStateFile,
    ),
    String,
> {
    let config_path = get_config_path(app);
    let secrets_path = get_secrets_path(app);
    let state_path = get_dropbox_credential_state_path(app);
    let _credential_guard = lock_dropbox_credential_state()?;
    let (_, provider_state) = read_sync_backend_publication_state_paths_unlocked_with(
        &config_path,
        &secrets_path,
        &state_path,
        || {},
    )?;
    let mut config = read_config_files_verified_unlocked(&config_path, &secrets_path)?;
    config.sync_backend = Some(
        normalize_backend(provider_state.sync_backend_marker.trim())
            .expect("validated Dropbox backend marker")
            .to_string(),
    );
    let webdav_password = resolve_sync_snapshot_secret_unlocked(
        &config_path,
        &secrets_path,
        &config,
        CredentialService::Webdav,
        get_keyring_secret(app, KEYRING_WEB_DAV_PASSWORD),
    )?;
    let cloud_token = resolve_sync_snapshot_secret_unlocked(
        &config_path,
        &secrets_path,
        &config,
        CredentialService::Cloud,
        get_keyring_secret(app, KEYRING_CLOUD_TOKEN),
    )?;
    Ok((config, webdav_password, cloud_token, provider_state))
}

fn read_raw_sync_backend_path_unlocked(config_path: &Path) -> Result<String, String> {
    Ok(read_config_toml_optional_strict(config_path)?
        .sync_backend
        .unwrap_or_else(|| "off".to_string()))
}

fn read_sync_backend_publication_state_paths_unlocked_with<AfterRawRead>(
    config_path: &Path,
    secrets_path: &Path,
    state_path: &Path,
    after_raw_read: AfterRawRead,
) -> Result<(String, DropboxCredentialStateFile), String>
where
    AfterRawRead: FnOnce(),
{
    // Initial migration derives the marker from the existing raw backend, so
    // an upgraded installation keeps its prior backend. After that point the
    // dedicated marker is the commit authority: a process that stopped after
    // publishing raw config but before publishing the marker did not commit.
    let state = load_or_migrate_dropbox_credential_state_paths_unlocked(
        config_path,
        secrets_path,
        state_path,
    )?;
    let mut raw_backend = read_raw_sync_backend_path_unlocked(config_path)?;
    after_raw_read();
    let marker = normalize_backend(state.sync_backend_marker.trim())
        .expect("validated Dropbox backend marker");
    if raw_backend.trim() != marker {
        let mut config = read_config_files_verified_unlocked(config_path, secrets_path)?;
        config.sync_backend = Some(marker.to_string());
        write_config_files_with_backend_authority_unlocked(
            config_path,
            secrets_path,
            &config,
            false,
        )?;
        raw_backend = read_raw_sync_backend_path_unlocked(config_path)?;
        if raw_backend.trim() != marker {
            return Err(
                "Sync backend failed torn-publication reconciliation read-back verification"
                    .to_string(),
            );
        }
    }
    Ok((raw_backend, state))
}

fn read_sync_backend_publication_state_paths_with<AfterRawRead>(
    config_path: &Path,
    secrets_path: &Path,
    state_path: &Path,
    after_raw_read: AfterRawRead,
) -> Result<(String, DropboxCredentialStateFile), String>
where
    AfterRawRead: FnOnce(),
{
    let _credential_guard = lock_dropbox_credential_state()?;
    read_sync_backend_publication_state_paths_unlocked_with(
        config_path,
        secrets_path,
        state_path,
        after_raw_read,
    )
}

pub(crate) fn read_sync_backend_publication_state(
    app: &tauri::AppHandle,
) -> Result<(String, DropboxCredentialStateFile), String> {
    read_sync_backend_publication_state_paths_with(
        &get_config_path(app),
        &get_secrets_path(app),
        &get_dropbox_credential_state_path(app),
        || {},
    )
}

fn publish_sync_backend_paths_unlocked_with<AfterRawReadback>(
    config_path: &Path,
    secrets_path: &Path,
    state_path: &Path,
    backend: &str,
    after_raw_readback: AfterRawReadback,
) -> Result<(), String>
where
    AfterRawReadback: FnOnce() -> Result<(), String>,
{
    let normalized =
        normalize_backend(backend.trim()).ok_or_else(|| "Invalid sync backend".to_string())?;

    // Establish the dedicated authority first, then reread the latest complete
    // config while still holding the caller's mutex. Only the backend field is
    // changed, so another native setter's unrelated update cannot be lost.
    load_or_migrate_dropbox_credential_state_paths_unlocked(config_path, secrets_path, state_path)?;
    let mut config = read_config_files_verified_unlocked(config_path, secrets_path)?;
    config.sync_backend = Some(normalized.to_string());
    write_config_files_with_backend_authority_unlocked(config_path, secrets_path, &config, false)?;
    if read_raw_sync_backend_path_unlocked(config_path)?.trim() != normalized {
        return Err("Sync backend failed durable config read-back verification".to_string());
    }
    after_raw_readback()?;

    update_dropbox_credential_state_paths_unlocked(
        config_path,
        secrets_path,
        state_path,
        |state| {
            state.sync_backend_marker = normalized.to_string();
            Ok(())
        },
    )?;
    let marker_readback = read_dropbox_credential_state_file(state_path)?
        .ok_or_else(|| "Sync backend marker disappeared after publication".to_string())?;
    if marker_readback.sync_backend_marker.trim() != normalized {
        return Err("Sync backend failed durable marker read-back verification".to_string());
    }

    let (final_raw, final_state) = read_sync_backend_publication_state_paths_unlocked_with(
        config_path,
        secrets_path,
        state_path,
        || {},
    )?;
    if final_raw.trim() != normalized || final_state.sync_backend_marker.trim() != normalized {
        return Err("Sync backend failed final durable pair verification".to_string());
    }
    Ok(())
}

fn publish_sync_backend_paths_with<AfterRawReadback>(
    config_path: &Path,
    secrets_path: &Path,
    state_path: &Path,
    backend: &str,
    after_raw_readback: AfterRawReadback,
) -> Result<(), String>
where
    AfterRawReadback: FnOnce() -> Result<(), String>,
{
    let _credential_guard = lock_dropbox_credential_state()?;
    publish_sync_backend_paths_unlocked_with(
        config_path,
        secrets_path,
        state_path,
        backend,
        after_raw_readback,
    )
}

fn normalize_obsidian_scan_folders(scan_folders: Vec<String>) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for raw in scan_folders {
        let trimmed = raw.trim().replace('\\', "/");
        let value = if trimmed.is_empty() || trimmed == "/" {
            "/".to_string()
        } else {
            trimmed
                .trim_start_matches('/')
                .trim_end_matches('/')
                .to_string()
        };
        if value.is_empty() || normalized.iter().any(|existing| existing == &value) {
            continue;
        }
        normalized.push(value);
    }
    if normalized.is_empty() {
        default_obsidian_scan_folders()
    } else {
        normalized
    }
}

fn normalize_obsidian_new_task_format(value: String) -> String {
    match value.trim() {
        "inline" => "inline".to_string(),
        "tasknotes" => "tasknotes".to_string(),
        _ => "auto".to_string(),
    }
}

fn normalize_obsidian_config_payload(payload: ObsidianConfigPayload) -> ObsidianConfigPayload {
    let vault_path = payload.vault_path.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let vault_name = if !payload.vault_name.trim().is_empty() {
        payload.vault_name.trim().to_string()
    } else if let Some(path) = vault_path.as_ref() {
        Path::new(path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .trim()
            .to_string()
    } else {
        String::new()
    };
    let last_scanned_at = payload.last_scanned_at.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    ObsidianConfigPayload {
        enabled: payload.enabled && vault_path.is_some(),
        vault_path,
        vault_name,
        scan_folders: normalize_obsidian_scan_folders(payload.scan_folders),
        inbox_file: normalize_obsidian_inbox_file(&payload.inbox_file),
        task_notes_include_archived: payload.task_notes_include_archived,
        dataview_metadata_enabled: payload.dataview_metadata_enabled,
        new_task_format: normalize_obsidian_new_task_format(payload.new_task_format),
        last_scanned_at,
    }
}

fn read_obsidian_config_payload(config: &AppConfigToml) -> ObsidianConfigPayload {
    let Some(raw) = config.obsidian_config.as_ref() else {
        return ObsidianConfigPayload::default();
    };
    serde_json::from_str::<ObsidianConfigPayload>(raw)
        .map(normalize_obsidian_config_payload)
        .unwrap_or_default()
}

fn expand_obsidian_payload_scope(app: &tauri::AppHandle, payload: &ObsidianConfigPayload) {
    let Some(vault_path) = payload.vault_path.as_ref() else {
        return;
    };
    expand_tauri_fs_scope(app, &PathBuf::from(vault_path));
}

// I1: the repair write below only holds lock_dropbox_credential_state, a
// different mutex from lock_config_read_modify_write — an RMW-lock holder's
// read..write gap could land a torn-publication repair here and then have it
// silently reverted by the RMW writer's stale-snapshot write. Outer RMW lock
// closes that; see lock_config_read_modify_write's LOCK ORDERING comment.
#[tauri::command(async)]
pub(crate) fn get_sync_backend(app: tauri::AppHandle) -> Result<String, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let (raw, state) = read_sync_backend_publication_state(&app)?;
    let marker = normalize_backend(state.sync_backend_marker.trim())
        .expect("validated Dropbox backend marker");
    if raw.trim() != marker {
        return Err("Sync backend reconciliation returned an inconsistent pair".to_string());
    }
    Ok(marker.to_string())
}

// I1: same race as get_sync_backend above — read_dropbox_credential_state's
// migration write only holds lock_dropbox_credential_state, not the RMW lock.
#[tauri::command(async)]
pub(crate) fn get_sync_cloud_provider(app: tauri::AppHandle) -> Result<String, String> {
    let _config_guard = lock_config_read_modify_write()?;
    Ok(read_dropbox_credential_state(&app)?.cloud_provider)
}

// Same as get_sync_cloud_provider above (I1) — identical migration-write path.
#[tauri::command(async)]
pub(crate) fn get_sync_cloud_provider_state(app: tauri::AppHandle) -> Result<Value, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let state = read_dropbox_credential_state(&app)?;
    Ok(serde_json::json!({
        "provider": state.cloud_provider,
        "authority": state.cloud_provider_authority,
    }))
}

// I1: read_sync_configuration_pair calls the same torn-publication repair
// path as get_sync_backend internally (read_sync_backend_publication_state_
// paths_unlocked_with) — not a pure read; same race, same fix.
#[tauri::command(async)]
pub(crate) fn get_sync_configuration_snapshot(
    app: tauri::AppHandle,
    require_webdav_password: Option<bool>,
    require_cloud_token: Option<bool>,
) -> Result<Value, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let (config, webdav_password, cloud_token, provider_state) =
        read_sync_configuration_pair(&app)?;
    if require_webdav_password.unwrap_or(false)
        && matches!(webdav_password, SyncSnapshotSecret::Opaque)
    {
        return Err("WebDAV password authority is unavailable".to_string());
    }
    if require_cloud_token.unwrap_or(false) && matches!(cloud_token, SyncSnapshotSecret::Opaque) {
        return Err("Self-hosted cloud token authority is unavailable".to_string());
    }
    Ok(sync_configuration_snapshot_value(
        &config,
        webdav_password,
        cloud_token,
        &provider_state.cloud_provider,
        &provider_state.cloud_provider_authority,
    ))
}

// I1: publish_sync_backend_paths_with only holds lock_dropbox_credential_state
// for its own read+mutate+write, so an RMW-lock holder's gap could still land
// a concurrent write here and lose it (or lose this one) — outer RMW lock.
#[tauri::command(async)]
pub(crate) fn set_sync_backend(app: tauri::AppHandle, backend: String) -> Result<bool, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let Some(normalized) = normalize_backend(backend.trim()) else {
        return Err("Invalid sync backend".to_string());
    };
    publish_sync_backend_paths_with(
        &get_config_path(&app),
        &get_secrets_path(&app),
        &get_dropbox_credential_state_path(&app),
        normalized,
        || Ok(()),
    )?;
    Ok(true)
}

// update_dropbox_credential_state/read_dropbox_credential_state each hold
// lock_dropbox_credential_state internally for their own file, but the tail
// config.sync_cloud_provider write below is a separate file with no lock of
// its own — held across the WHOLE body (B3) so no other config.rs setter can
// interleave. Different mutex from lock_dropbox_credential_state, so nesting
// it around calls that take that one internally is deadlock-safe (see
// lock_config_read_modify_write's definition).
#[tauri::command(async)]
pub(crate) fn set_sync_cloud_provider(
    app: tauri::AppHandle,
    provider: String,
) -> Result<bool, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let Some(normalized) = normalize_sync_cloud_provider(provider.trim()) else {
        return Err("Invalid cloud sync provider".to_string());
    };
    // The dedicated marker is recovery authority and must move first. The
    // renderer only activates `cloud` after this command returns and reads the
    // provider back exactly.
    update_dropbox_credential_state(&app, |state| {
        state.cloud_provider = normalized.to_string();
        state.cloud_provider_authority = "native".to_string();
        Ok(())
    })?;
    let persisted = read_dropbox_credential_state(&app)?;
    if persisted.cloud_provider != normalized || persisted.cloud_provider_authority != "native" {
        return Err("Cloud sync provider failed durable marker read-back verification".to_string());
    }

    let mut config = read_config(&app);
    config.sync_cloud_provider = Some(normalized.to_string());
    write_config_files(&get_config_path(&app), &get_secrets_path(&app), &config)?;
    Ok(true)
}

// Pure read, no write branch (B3) — no lock needed.
#[tauri::command(async)]
pub(crate) fn get_obsidian_config(app: tauri::AppHandle) -> Result<Value, String> {
    let config = read_config(&app);
    serde_json::to_value(read_obsidian_config_payload(&config)).map_err(|e| e.to_string())
}

// Held across the whole read+mutate+write (B3) — see lock_config_read_modify_write.
#[tauri::command(async)]
pub(crate) fn set_obsidian_config(app: tauri::AppHandle, config: Value) -> Result<Value, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let payload = serde_json::from_value::<ObsidianConfigPayload>(config)
        .map(normalize_obsidian_config_payload)
        .map_err(|e| format!("Invalid Obsidian config: {e}"))?;
    let config_path = get_config_path(&app);
    let mut current = read_config(&app);
    current.obsidian_config = Some(
        serde_json::to_string(&payload)
            .map_err(|e| format!("Failed to encode Obsidian config: {e}"))?,
    );
    write_config_files(&config_path, &get_secrets_path(&app), &current)?;
    expand_obsidian_payload_scope(&app, &payload);
    serde_json::to_value(payload).map_err(|e| e.to_string())
}

// No config.toml I/O at all — just a Tauri fs-scope grant (B3) — no lock needed.
#[tauri::command(async)]
pub(crate) fn expand_obsidian_vault_scope(
    app: tauri::AppHandle,
    vault_path: String,
) -> Result<bool, String> {
    let trimmed = vault_path.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    expand_tauri_fs_scope(&app, &PathBuf::from(trimmed));
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DetectedObsidianVault {
    name: String,
    path: String,
}

fn obsidian_registry_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    // Obsidian keeps a registry of every vault it has opened in
    // <config-dir>/obsidian/obsidian.json on all three platforms.
    if let Some(config_dir) = dirs::config_dir() {
        paths.push(config_dir.join("obsidian").join("obsidian.json"));
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            // Flatpak-packaged Obsidian keeps its config inside the sandbox home.
            paths.push(home.join(".var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json"));
        }
    }
    paths
}

pub(crate) fn parse_obsidian_vault_registry(contents: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(contents) else {
        return Vec::new();
    };
    let Some(vaults) = value.get("vaults").and_then(|entry| entry.as_object()) else {
        return Vec::new();
    };
    let mut paths: Vec<String> = vaults
        .values()
        .filter_map(|vault| vault.get("path").and_then(|path| path.as_str()))
        .map(str::to_string)
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

// Off the UI thread: a stale registry entry can point at an unmounted network
// share, where the `is_dir` probe below blocks. Read-only, so no locking.
#[tauri::command(async)]
pub(crate) fn list_obsidian_vaults() -> Vec<DetectedObsidianVault> {
    let mut vaults = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for registry in obsidian_registry_paths() {
        let Ok(contents) = fs::read_to_string(&registry) else {
            continue;
        };
        for path in parse_obsidian_vault_registry(&contents) {
            if !seen.insert(path.clone()) {
                continue;
            }
            // The registry can hold stale entries; only offer vaults that still exist.
            if !Path::new(&path).is_dir() {
                continue;
            }
            let name = Path::new(&path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(path.as_str())
                .to_string();
            vaults.push(DetectedObsidianVault { name, path });
        }
    }
    vaults
}

// Off the UI thread for the same reason as `list_obsidian_vaults`: the vault
// path comes from the user and may be a slow or dead mount.
#[tauri::command(async)]
pub(crate) fn check_obsidian_vault_marker(vault_path: String) -> Result<bool, String> {
    let trimmed = vault_path.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    let marker_path = Path::new(trimmed).join(".obsidian");
    match fs::metadata(marker_path) {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

// read_bound_credential already holds lock_dropbox_credential_state across
// its whole span (B3) — safe as-is.
#[tauri::command(async)]
pub(crate) fn get_webdav_config(app: tauri::AppHandle) -> Result<Value, String> {
    let (config, password) = read_bound_credential(&app, CredentialService::Webdav)?;
    Ok(serde_json::json!({
        "url": config.webdav_url.unwrap_or_default(),
        "username": config.webdav_username.unwrap_or_default(),
        "hasPassword": password.is_some(),
        "allowInsecureHttp": config.webdav_allow_insecure_http.as_deref() == Some("true"),
        "allowWeakFingerprint": config.webdav_allow_weak_fingerprint.as_deref() != Some("false")
    }))
}

fn validate_webdav_config_url(url: &str, allow_insecure_http: bool) -> Result<(), String> {
    if url.trim().is_empty() {
        return Ok(());
    }
    crate::sync::assert_webdav_url_allowed(url, allow_insecure_http)
}

// I1: update_bound_credential only holds lock_dropbox_credential_state for
// its own transaction — that serializes it against other CRED-only callers,
// but not against an RMW-lock holder's read..write gap on config.toml. Outer
// RMW lock closes that (deadlock-safe: update_bound_credential's internal
// CRED lock is a different mutex — see the LOCK ORDERING comment).
#[tauri::command(async)]
pub(crate) fn set_webdav_config(
    app: tauri::AppHandle,
    url: String,
    username: String,
    password: String,
    allow_insecure_http: Option<bool>,
    allow_weak_fingerprint: Option<bool>,
    replace_password: Option<bool>,
) -> Result<bool, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let url = url.trim().to_string();
    let allow_insecure_http = allow_insecure_http.unwrap_or(false);
    validate_webdav_config_url(&url, allow_insecure_http)?;
    let should_replace_password = replace_password.unwrap_or(false) || !password.trim().is_empty();
    let next_password = if password.trim().is_empty() {
        None
    } else {
        Some(password.trim().to_string())
    };
    let secret_update = if url.is_empty() {
        CredentialSecretUpdate::Replace(None)
    } else if should_replace_password {
        CredentialSecretUpdate::Replace(next_password.clone())
    } else {
        CredentialSecretUpdate::Keep
    };
    let username = username.trim().to_string();
    let persisted =
        update_bound_credential(&app, CredentialService::Webdav, secret_update, |config| {
            if url.is_empty() {
                config.webdav_url = None;
                config.webdav_username = None;
                config.webdav_allow_insecure_http = None;
                config.webdav_allow_weak_fingerprint = None;
                return;
            }
            config.webdav_url = Some(url);
            config.webdav_username = Some(username);
            config.webdav_allow_insecure_http = Some(if allow_insecure_http {
                "true".to_string()
            } else {
                "false".to_string()
            });
            if let Some(allow_weak_fingerprint) = allow_weak_fingerprint {
                config.webdav_allow_weak_fingerprint = Some(if allow_weak_fingerprint {
                    "true".to_string()
                } else {
                    "false".to_string()
                });
            }
        })?;
    if persisted.webdav_password.is_some() && next_password.is_some() {
        emit_keyring_fallback_warning(&app, "WebDAV password");
    }
    Ok(true)
}

// Same as get_webdav_config above (B3) — safe as-is.
#[tauri::command(async)]
pub(crate) fn get_webdav_password(app: tauri::AppHandle) -> Result<String, String> {
    let (_, password) = read_bound_credential(&app, CredentialService::Webdav)?;
    Ok(password.unwrap_or_default())
}

// Same as get_webdav_config above (B3) — safe as-is.
#[tauri::command(async)]
pub(crate) fn get_cloud_config(app: tauri::AppHandle) -> Result<Value, String> {
    let (config, token) = read_bound_credential(&app, CredentialService::Cloud)?;
    Ok(serde_json::json!({
        "url": config.cloud_url.unwrap_or_default(),
        "token": token.unwrap_or_default(),
        "allowInsecureHttp": config.cloud_allow_insecure_http.as_deref() == Some("true")
    }))
}

// Same as set_webdav_config above (I1) — outer RMW lock.
#[tauri::command(async)]
pub(crate) fn set_cloud_config(
    app: tauri::AppHandle,
    url: String,
    token: String,
    allow_insecure_http: Option<bool>,
) -> Result<bool, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let url = url.trim().to_string();
    let next_token = {
        let trimmed = token.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    };

    let allow_insecure_http = allow_insecure_http.unwrap_or(false);
    let persisted = update_bound_credential(
        &app,
        CredentialService::Cloud,
        CredentialSecretUpdate::Replace(if url.is_empty() {
            None
        } else {
            next_token.clone()
        }),
        |config| {
            if url.is_empty() {
                config.cloud_url = None;
                config.cloud_allow_insecure_http = None;
            } else {
                config.cloud_url = Some(url);
                config.cloud_allow_insecure_http = Some(if allow_insecure_http {
                    "true".to_string()
                } else {
                    "false".to_string()
                });
            }
        },
    )?;
    if persisted.cloud_token.is_some() && next_token.is_some() {
        emit_keyring_fallback_warning(&app, "Cloud token");
    }
    Ok(true)
}

// Held across the whole read+mutate+write (B3) — see lock_config_read_modify_write.
#[tauri::command(async)]
pub(crate) fn set_network_proxy(app: tauri::AppHandle, proxy_url: String) -> Result<bool, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let trimmed = proxy_url.trim().to_string();
    if !trimmed.is_empty() {
        let parsed =
            reqwest::Url::parse(&trimmed).map_err(|error| format!("Invalid proxy URL: {error}"))?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err("Proxy URL must use http:// or https://".to_string());
        }
    }
    let next = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    let config_path = get_config_path(&app);
    let mut config = read_config(&app);
    if config.proxy_url == next {
        return Ok(true);
    }
    config.proxy_url = next;
    write_config_files(&config_path, &get_secrets_path(&app), &config)?;
    Ok(true)
}

// Pure read, no write branch (B3) — no lock needed.
#[tauri::command(async)]
pub(crate) fn get_external_calendars(
    app: tauri::AppHandle,
) -> Result<Vec<ExternalCalendarSubscription>, String> {
    let config = read_config(&app);
    let raw = config
        .external_calendars
        .unwrap_or_else(|| "[]".to_string());
    let parsed: Vec<ExternalCalendarSubscription> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(parsed
        .into_iter()
        .filter(|c| !c.url.trim().is_empty())
        .map(|mut c| {
            c.url = c.url.trim().to_string();
            c.name = c.name.trim().to_string();
            if c.name.is_empty() {
                c.name = "Calendar".to_string();
            }
            c
        })
        .collect())
}

// Held across the whole read+mutate+write (B3) — see lock_config_read_modify_write.
#[tauri::command(async)]
pub(crate) fn set_external_calendars(
    app: tauri::AppHandle,
    calendars: Vec<ExternalCalendarSubscription>,
) -> Result<bool, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let config_path = get_config_path(&app);
    let mut config = read_config(&app);
    let sanitized: Vec<ExternalCalendarSubscription> = calendars
        .into_iter()
        .filter(|c| is_valid_calendar_url(&c.url))
        .map(|mut c| {
            c.url = c.url.trim().to_string();
            c.name = c.name.trim().to_string();
            if c.name.is_empty() {
                c.name = "Calendar".to_string();
            }
            c
        })
        .collect();

    config.external_calendars = Some(serde_json::to_string(&sanitized).map_err(|e| e.to_string())?);
    write_config_files(&config_path, &get_secrets_path(&app), &config)?;
    Ok(true)
}

/// Local `.ics` subscriptions are read here rather than through the Tauri fs
/// plugin: its scope check canonicalizes the path first, and canonicalize is
/// unimplemented on the virtual volumes (rclone/WinFSP mounts) these files
/// often live on, so the read could never be allowed. No path resolution of
/// any kind happens below.
#[tauri::command(async)]
pub(crate) fn read_external_calendar_file(
    app: tauri::AppHandle,
    url: String,
) -> Result<String, String> {
    let config = read_config(&app);
    let path = configured_calendar_file_path(config.external_calendars.as_deref(), &url)
        .ok_or_else(|| format!("Not a subscribed calendar file: {}", url.trim()))?;
    fs::read_to_string(&path).map_err(|error| format!("Failed to read {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_network_calendar_urls() {
        assert!(is_valid_calendar_url("https://calendar.example/work.ics"));
        assert!(is_valid_calendar_url("http://calendar.example/work.ics"));
        assert!(is_valid_calendar_url("webcal://calendar.example/work.ics"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn accepts_absolute_file_calendar_urls() {
        let path = calendar_file_url_to_path("file:///tmp/My%20Calendar.ICS").unwrap();
        assert!(path.is_absolute());
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("My Calendar.ICS")
        );
        assert!(is_valid_calendar_url("file:///tmp/My%20Calendar.ICS"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn accepts_absolute_windows_file_calendar_urls() {
        let path = calendar_file_url_to_path("file:///C:/Users/demo/My%20Calendar.ICS").unwrap();
        assert!(path.is_absolute());
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("My Calendar.ICS")
        );
        assert!(is_valid_calendar_url(
            "file:///C:/Users/demo/My%20Calendar.ICS"
        ));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn reads_only_subscribed_calendar_files() {
        let raw = r#"[{"id":"a","name":"Work","url":"file:///tmp/agenda.ics","enabled":true,"color":null}]"#;
        assert_eq!(
            configured_calendar_file_path(Some(raw), " file:///tmp/agenda.ics "),
            Some(PathBuf::from("/tmp/agenda.ics"))
        );
        assert_eq!(
            configured_calendar_file_path(Some(raw), "file:///etc/shadow.ics"),
            None
        );
        assert_eq!(
            configured_calendar_file_path(None, "file:///tmp/agenda.ics"),
            None
        );
    }

    #[test]
    fn rejects_invalid_file_calendar_urls() {
        assert!(!is_valid_calendar_url("file://agenda.ics"));
        assert!(!is_valid_calendar_url("file:///tmp/agenda.txt"));
        assert!(!is_valid_calendar_url("file:///tmp/bad%ZZ.ics"));
    }

    #[test]
    fn webdav_config_save_requires_https_for_public_urls_without_override() {
        assert!(validate_webdav_config_url("https://dav.example.com/mindwtr", false).is_ok());
        assert!(validate_webdav_config_url("http://nas.local:8080/mindwtr", false).is_ok());
        assert!(validate_webdav_config_url("http://dav.example.com/mindwtr", false).is_err());
        assert!(validate_webdav_config_url("http://dav.example.com/mindwtr", true).is_ok());
    }

    #[test]
    fn parses_obsidian_vault_registry_paths() {
        let registry = r#"{
            "vaults": {
                "a1b2": { "path": "/home/user/Vaults/Notes", "ts": 1, "open": true },
                "c3d4": { "path": "/home/user/Vaults/Work", "ts": 2 },
                "dupe": { "path": "/home/user/Vaults/Notes", "ts": 3 }
            }
        }"#;
        assert_eq!(
            super::parse_obsidian_vault_registry(registry),
            vec![
                "/home/user/Vaults/Notes".to_string(),
                "/home/user/Vaults/Work".to_string(),
            ]
        );
        assert!(super::parse_obsidian_vault_registry("not json").is_empty());
        assert!(super::parse_obsidian_vault_registry("{}").is_empty());
    }

    fn fully_populated_config() -> AppConfigToml {
        AppConfigToml {
            sync_path: Some("/home/user/Sync".to_string()),
            sync_path_bookmark: Some("bookmark-data".to_string()),
            sync_backend: Some("webdav".to_string()),
            webdav_url: Some("https://dav.example.com/mindwtr".to_string()),
            webdav_username: Some("demo".to_string()),
            // Embedded quote and backslash exercise the escaping path.
            webdav_password: Some("s3cr3t \"pass\" with \\backslash".to_string()),
            webdav_allow_insecure_http: Some("false".to_string()),
            webdav_allow_weak_fingerprint: Some("true".to_string()),
            cloud_url: Some("https://cloud.example.com".to_string()),
            cloud_token: Some("cloud-token-value".to_string()),
            cloud_allow_insecure_http: Some("false".to_string()),
            proxy_url: Some("http://proxy.example.com:8080".to_string()),
            dropbox_tokens: Some("{\"access_token\":\"abc\"}".to_string()),
            obsidian_config: Some("{\"vaultPath\":\"/vault\"}".to_string()),
            external_calendars: Some("[{\"url\":\"https://cal.example.com/a.ics\"}]".to_string()),
            ai_key_openai: Some("sk-openai".to_string()),
            ai_key_anthropic: Some("sk-anthropic".to_string()),
            ai_key_gemini: Some("sk-gemini".to_string()),
            email_capture_config: Some("{\"host\":\"imap.example.com\"}".to_string()),
            email_capture_password: Some("email-secret".to_string()),
            local_api_enabled: Some("true".to_string()),
            local_api_port: Some("3456".to_string()),
            local_api_token: Some("local-api-token-value".to_string()),
            disable_hardware_acceleration: Some("true".to_string()),
            autostart_startup_flag_migrated: Some("true".to_string()),
            dropbox_promotion_journal: Some("dropbox-journal-secret".to_string()),
            sync_cloud_provider: Some("dropbox".to_string()),
        }
    }

    #[test]
    fn config_toml_write_then_read_is_identity_for_every_field() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let path = dir.path().join("config.toml");
        let original = fully_populated_config();

        write_config_toml(&path, &original).expect("should write config.toml");
        let read_back = read_config_toml(&path);

        assert_eq!(read_back, original);
    }

    #[test]
    fn config_toml_written_by_a_shipped_version_still_parses() {
        // Hand-written in the exact shape the pre-serde `write_config_toml_with_header`
        // emitted: one header comment line, then `key = "value"` lines in the
        // same order it wrote them. New code must keep reading this shape.
        let legacy_config = concat!(
            "# Mindwtr desktop config\n",
            "sync_path = \"/home/user/Sync\"\n",
            "sync_backend = \"webdav\"\n",
            "webdav_url = \"https://dav.example.com/mindwtr\"\n",
            "webdav_allow_insecure_http = \"false\"\n",
            "local_api_port = \"3456\"\n",
            "disable_hardware_acceleration = \"true\"\n",
        );
        let dir = tempfile::tempdir().expect("should create temp dir");
        let path = dir.path().join("config.toml");
        fs::write(&path, legacy_config).expect("should write legacy config.toml");

        let config = read_config_toml(&path);

        assert_eq!(config.sync_path.as_deref(), Some("/home/user/Sync"));
        assert_eq!(config.sync_backend.as_deref(), Some("webdav"));
        assert_eq!(
            config.webdav_url.as_deref(),
            Some("https://dav.example.com/mindwtr")
        );
        assert_eq!(config.webdav_allow_insecure_http.as_deref(), Some("false"));
        assert_eq!(config.local_api_port.as_deref(), Some("3456"));
        assert_eq!(
            config.disable_hardware_acceleration.as_deref(),
            Some("true")
        );
        // Everything the legacy file didn't mention stays None, exactly as the
        // old ad hoc parser left unmatched keys as None.
        assert_eq!(config.cloud_url, None);
        assert_eq!(config.local_api_token, None);
    }

    #[test]
    fn write_config_files_never_leaks_a_secret_field_into_the_public_config() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let original = fully_populated_config();

        write_config_files(&config_path, &secrets_path, &original)
            .expect("should write config and secrets files");

        let public_config = read_config_toml(&config_path);
        let secrets_config = read_config_toml(&secrets_path);
        let public_raw = fs::read_to_string(&config_path).expect("should read public config");

        for &field in SECRET_FIELDS {
            let secret_value = config_as_object(&original)
                .remove(field)
                .and_then(|value| value.as_str().map(str::to_string))
                .expect("fully populated config sets every secret field");

            // Structural check: the field itself is absent from the public struct...
            assert!(
                config_as_object(&public_config).get(field).is_none(),
                "{field} must not be present in the public config"
            );
            // ...and the raw text never contains the secret value either.
            assert!(
                !public_raw.contains(&secret_value),
                "{field}'s value leaked into the public config.toml text"
            );
            // It must have moved to secrets.toml instead.
            assert_eq!(
                config_as_object(&secrets_config)
                    .get(field)
                    .and_then(Value::as_str),
                Some(secret_value.as_str()),
                "{field} should have moved to secrets.toml"
            );
        }

        // Non-secret fields still round-trip through the public file.
        assert_eq!(public_config.sync_backend, original.sync_backend);
        assert_eq!(public_config.local_api_port, original.local_api_port);
    }

    #[test]
    fn sync_configuration_snapshot_keeps_empty_and_dormant_transport_values() {
        let mut config = AppConfigToml::default();
        config.sync_backend = Some("cloud".to_string());
        config.sync_path = None;
        config.webdav_url = Some("https://dormant-dav.example.com".to_string());
        config.webdav_username = Some("alice".to_string());
        config.webdav_allow_insecure_http = Some("false".to_string());
        config.webdav_allow_weak_fingerprint = Some("false".to_string());
        config.cloud_url = Some("https://active-cloud.example.com".to_string());
        config.cloud_allow_insecure_http = Some("true".to_string());

        let snapshot = sync_configuration_snapshot_value(
            &config,
            SyncSnapshotSecret::Known("webdav-secret".to_string()),
            SyncSnapshotSecret::Known("cloud-secret".to_string()),
            "selfhosted",
            "native",
        );

        assert_eq!(snapshot["backend"], "cloud");
        assert_eq!(snapshot["syncPath"], "");
        assert_eq!(snapshot["webdav"]["url"], "https://dormant-dav.example.com");
        assert_eq!(snapshot["webdav"]["password"], "webdav-secret");
        assert_eq!(snapshot["webdav"]["passwordAuthority"], "known");
        assert_eq!(snapshot["webdav"]["hasPassword"], true);
        assert_eq!(snapshot["webdav"]["allowWeakFingerprint"], false);
        assert_eq!(snapshot["cloud"]["url"], "https://active-cloud.example.com");
        assert_eq!(snapshot["cloud"]["token"], "cloud-secret");
        assert_eq!(snapshot["cloud"]["tokenAuthority"], "known");
        assert_eq!(snapshot["cloudProvider"], "selfhosted");
        assert_eq!(snapshot["cloudProviderAuthority"], "native");
        assert_eq!(snapshot["cloud"]["allowInsecureHttp"], true);
    }

    #[test]
    fn sync_snapshot_distinguishes_known_empty_from_opaque_secrets() {
        assert_eq!(
            sync_snapshot_secret_with(Ok(None), Ok(None)),
            SyncSnapshotSecret::Known(String::new())
        );
        assert_eq!(
            sync_snapshot_secret_with(
                Err("keyring unavailable".to_string()),
                Ok(Some("fallback-secret".to_string())),
            ),
            SyncSnapshotSecret::Known("fallback-secret".to_string())
        );
        assert_eq!(
            sync_snapshot_secret_with(Err("keyring unavailable".to_string()), Ok(None)),
            SyncSnapshotSecret::Opaque
        );
        assert_eq!(
            sync_snapshot_secret_with(Ok(None), Err("corrupt fallback".to_string())),
            SyncSnapshotSecret::Opaque
        );

        let snapshot = sync_configuration_snapshot_value(
            &AppConfigToml::default(),
            SyncSnapshotSecret::Opaque,
            SyncSnapshotSecret::Opaque,
            "dropbox",
            "native",
        );
        assert!(snapshot["webdav"]["password"].is_null());
        assert!(snapshot["webdav"]["hasPassword"].is_null());
        assert_eq!(snapshot["webdav"]["passwordAuthority"], "opaque");
        assert!(snapshot["cloud"]["token"].is_null());
        assert_eq!(snapshot["cloud"]["tokenAuthority"], "opaque");
        assert_eq!(snapshot["cloudProvider"], "dropbox");
    }

    #[test]
    fn sync_snapshot_tolerates_unavailable_authorities_but_not_endpoint_mismatches() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
            .expect("seed config");
        let initial =
            read_config_files_verified(&config_path, &secrets_path).expect("read initial config");

        assert_eq!(
            resolve_sync_snapshot_secret_unlocked(
                &config_path,
                &secrets_path,
                &initial,
                CredentialService::Cloud,
                Err("keyring unavailable".to_string()),
            )
            .expect("an unrelated unavailable authority stays opaque"),
            SyncSnapshotSecret::Opaque,
        );

        let keyring = std::cell::RefCell::new(None::<String>);
        let committed = update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            CredentialSecretUpdate::Replace(Some("cloud-token".to_string())),
            |config| config.cloud_url = Some("https://trusted.example".to_string()),
            || Ok(keyring.borrow().clone()),
            |secret| {
                *keyring.borrow_mut() = secret;
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("commit bound cloud credential");
        assert_eq!(
            resolve_sync_snapshot_secret_unlocked(
                &config_path,
                &secrets_path,
                &committed,
                CredentialService::Cloud,
                Err("keyring unavailable".to_string()),
            )
            .expect("a matching but unavailable bound authority stays opaque"),
            SyncSnapshotSecret::Opaque,
        );

        let mut changed_endpoint = committed;
        changed_endpoint.cloud_url = Some("https://wrong.example".to_string());
        write_config_files(&config_path, &secrets_path, &changed_endpoint)
            .expect("publish changed endpoint");
        let error = resolve_sync_snapshot_secret_unlocked(
            &config_path,
            &secrets_path,
            &changed_endpoint,
            CredentialService::Cloud,
            Err("keyring unavailable".to_string()),
        )
        .expect_err("an endpoint mismatch must remain fail-closed");
        assert!(error.contains("endpoint does not match"));
    }

    #[test]
    fn sync_snapshot_preserves_legacy_public_secrets_but_prefers_private_split() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let public = AppConfigToml {
            webdav_password: Some("legacy-public-webdav".to_string()),
            cloud_token: Some("legacy-public-cloud".to_string()),
            ..AppConfigToml::default()
        };
        write_config_toml(&config_path, &public).expect("write legacy public secrets");

        let (_, webdav, cloud) =
            read_snapshot_config_paths(&config_path, &secrets_path).expect("read legacy snapshot");
        assert_eq!(webdav, Ok(Some("legacy-public-webdav".to_string())));
        assert_eq!(cloud, Ok(Some("legacy-public-cloud".to_string())));

        let private = AppConfigToml {
            webdav_password: Some("private-webdav".to_string()),
            cloud_token: Some("private-cloud".to_string()),
            ..AppConfigToml::default()
        };
        write_secrets_toml(&secrets_path, &private).expect("write private split");
        let (_, webdav, cloud) =
            read_snapshot_config_paths(&config_path, &secrets_path).expect("read split snapshot");
        assert_eq!(webdav, Ok(Some("private-webdav".to_string())));
        assert_eq!(cloud, Ok(Some("private-cloud".to_string())));

        fs::write(&secrets_path, "cloud_token = truncated-token\n").expect("corrupt private split");
        let (_, webdav, cloud) = read_snapshot_config_paths(&config_path, &secrets_path)
            .expect("corrupt private split yields opaque secret authority");
        assert!(webdav.is_err());
        assert!(cloud.is_err());
    }

    #[test]
    fn secrets_publication_failure_preserves_the_existing_file() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let secrets_path = dir.path().join("secrets.toml");
        let original = b"# Mindwtr desktop secrets\nlocal_api_token = \"old-token\"\n";
        fs::write(&secrets_path, original).expect("write existing secrets");
        let mut replacement = AppConfigToml::default();
        replacement.local_api_token = Some("new-token".to_string());

        let result = write_secrets_toml_with_hooks(
            &secrets_path,
            &replacement,
            restrict_to_owner,
            |temp_file, _destination| {
                drop(temp_file);
                Err("injected secrets publication failure".to_string())
            },
        );

        assert_eq!(
            result.expect_err("publication must fail"),
            "injected secrets publication failure"
        );
        assert_eq!(
            fs::read(&secrets_path).expect("existing secrets remain"),
            original,
            "atomic publication failure must not truncate credentials"
        );
        assert_eq!(
            fs::read_dir(dir.path())
                .expect("read secrets directory")
                .count(),
            1,
            "the failed temporary file is cleaned up"
        );
    }

    #[cfg(unix)]
    #[test]
    fn secrets_toml_is_owner_only() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let secrets_path = dir.path().join("secrets.toml");

        write_config_files(
            &dir.path().join("config.toml"),
            &secrets_path,
            &fully_populated_config(),
        )
        .expect("should write config and secrets files");

        let mode = fs::metadata(&secrets_path)
            .expect("secrets.toml should exist")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "secrets.toml must not be readable by other users"
        );
    }

    #[cfg(unix)]
    #[test]
    fn secrets_toml_stays_owner_only_on_overwrite() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let config = fully_populated_config();

        write_config_files(&config_path, &secrets_path, &config).expect("should write first time");
        // Loosen both, as a file left behind by a pre-fix build would be, so
        // the second write has to actually re-apply the restriction.
        fs::set_permissions(&secrets_path, fs::Permissions::from_mode(0o644))
            .expect("should loosen secrets.toml");
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755))
            .expect("should loosen the containing dir");

        write_config_files(&config_path, &secrets_path, &config).expect("should write second time");

        let file_mode = fs::metadata(&secrets_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            file_mode, 0o600,
            "an overwrite must restore owner-only access on secrets.toml"
        );
        let dir_mode = fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            dir_mode, 0o700,
            "the directory holding secrets.toml must not be traversable by other users"
        );
    }

    #[cfg(unix)]
    #[test]
    fn secrets_toml_is_restricted_before_plaintext_is_written() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secrets_path = dir.path().join("secrets.toml");
        let mut saw_empty_secret_file = false;

        write_secrets_toml_with_restrict(&secrets_path, &fully_populated_config(), |path, mode| {
            if path.is_file() && path != secrets_path {
                assert_eq!(mode, 0o600);
                assert_eq!(fs::metadata(path).expect("temp metadata").len(), 0);
                saw_empty_secret_file = true;
            }
            restrict_to_owner(path, mode)
        })
        .expect("secure write");

        assert!(
            saw_empty_secret_file,
            "the empty file is protected before content is written"
        );
        assert!(
            fs::read_to_string(&secrets_path)
                .expect("secrets content")
                .contains("local-api-token-value"),
            "the protected file receives the serialized secrets"
        );
    }

    #[cfg(unix)]
    #[test]
    fn secrets_toml_prewrite_permission_failure_leaves_no_plaintext_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secrets_path = dir.path().join("secrets.toml");

        let result = write_secrets_toml_with_restrict(
            &secrets_path,
            &fully_populated_config(),
            |path, mode| {
                if path.is_file() {
                    assert_eq!(mode, 0o600);
                    assert_eq!(fs::metadata(path).expect("temp metadata").len(), 0);
                    return Err("injected chmod failure".to_string());
                }
                restrict_to_owner(path, mode)
            },
        );

        assert_eq!(
            result.expect_err("write must fail"),
            "injected chmod failure"
        );
        assert!(!secrets_path.exists(), "no destination file is published");
        assert_eq!(
            fs::read_dir(dir.path())
                .expect("read secrets directory")
                .count(),
            0,
            "the empty temporary file is cleaned up"
        );
    }

    #[test]
    fn write_config_files_refuses_to_overwrite_an_unparseable_config_toml() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        // Bare (unquoted) value: syntactically invalid TOML, as if the file
        // were hand-edited or truncated mid-write.
        let corrupt = "# Mindwtr desktop config\nsync_backend = webdav\n";
        fs::write(&config_path, corrupt).expect("should write corrupt config.toml");

        // Reproduces the real read-modify-write flow every setter uses:
        // read (falls back to default() because the file won't parse), set
        // one field, write back.
        let mut config = read_config_toml(&config_path);
        assert_eq!(config.sync_backend, None, "corrupt file reads as empty");
        config.local_api_port = Some("3456".to_string());

        let result = write_config_files(&config_path, &secrets_path, &config);

        assert!(result.is_err(), "write must refuse, not silently succeed");
        let on_disk = fs::read_to_string(&config_path).expect("config.toml should still exist");
        assert_eq!(
            on_disk, corrupt,
            "the original corrupt file must survive completely untouched"
        );
    }

    #[test]
    fn public_setting_write_preserves_both_files_when_secrets_are_unparseable() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let public = b"# Mindwtr desktop config\nsync_backend = \"off\"\n";
        let corrupt_secrets = b"# Mindwtr desktop secrets\nlocal_api_token = truncated-token\n";
        fs::write(&config_path, public).expect("write public config");
        fs::write(&secrets_path, corrupt_secrets).expect("write corrupt secrets");

        // Match a normal public-setting read/modify/write. The unreadable
        // secrets currently look empty to read_config_toml, but that must not
        // authorize deleting the only recoverable credential bytes.
        let mut config = read_config_toml(&config_path);
        merge_config(&mut config, read_config_toml(&secrets_path));
        config.local_api_port = Some("3456".to_string());

        let result = write_config_files(&config_path, &secrets_path, &config);

        assert!(
            result.is_err(),
            "the two-file write must fail before mutation"
        );
        assert_eq!(
            fs::read(&config_path).expect("public config remains"),
            public,
            "config.toml must remain byte-identical"
        );
        assert_eq!(
            fs::read(&secrets_path).expect("secrets remain"),
            corrupt_secrets,
            "recoverable secret bytes must never be removed"
        );
    }

    #[test]
    fn atomic_config_publication_does_not_acknowledge_a_namespace_barrier_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");

        let error = write_atomic_text_with_hooks(
            &config_path,
            "sync_backend = \"off\"\n",
            false,
            |temp_file, destination| {
                temp_file
                    .persist(destination)
                    .map(|_| ())
                    .map_err(|error| error.error.to_string())
            },
            |parent| {
                assert_eq!(parent, dir.path());
                Err("injected namespace durability failure".to_string())
            },
        )
        .expect_err("a failed namespace barrier must not acknowledge publication");

        assert_eq!(error, "injected namespace durability failure");
        assert_eq!(
            fs::read_to_string(&config_path).expect("rename completed before the barrier"),
            "sync_backend = \"off\"\n"
        );
    }

    #[test]
    fn config_deletion_does_not_acknowledge_a_namespace_barrier_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secrets_path = dir.path().join("secrets.toml");
        fs::write(&secrets_path, "local_api_token = \"secret\"\n").expect("seed secret");

        let error = remove_file_durably_with_hooks(
            &secrets_path,
            |path| match fs::remove_file(path) {
                Ok(()) => Ok(true),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(error.to_string()),
            },
            |parent| {
                assert_eq!(parent, dir.path());
                Err("injected deletion durability failure".to_string())
            },
        )
        .expect_err("a failed namespace barrier must not acknowledge deletion");

        assert_eq!(error, "injected deletion durability failure");
        assert!(
            !secrets_path.exists(),
            "delete completed before the barrier"
        );
    }

    #[test]
    fn config_pair_publication_rolls_back_every_failed_stage() {
        for failed_stage in ConfigPublicationStage::ALL {
            let dir = tempfile::tempdir().expect("tempdir");
            let config_path = dir.path().join("config.toml");
            let secrets_path = dir.path().join("secrets.toml");
            let previous = AppConfigToml {
                local_api_port: Some("1111".to_string()),
                local_api_token: Some("old-secret".to_string()),
                ..AppConfigToml::default()
            };
            write_config_files(&config_path, &secrets_path, &previous).expect("seed config");
            let replacement = AppConfigToml {
                local_api_port: Some("2222".to_string()),
                local_api_token: Some("new-secret".to_string()),
                ..AppConfigToml::default()
            };

            let result = write_config_files_with_stage_hook(
                &config_path,
                &secrets_path,
                &replacement,
                |stage| {
                    if stage == failed_stage {
                        Err(format!("injected {stage:?} failure"))
                    } else {
                        Ok(())
                    }
                },
            );

            assert!(
                result.is_err(),
                "{failed_stage:?} must not acknowledge success"
            );
            let recovered = read_config_files_verified(&config_path, &secrets_path)
                .expect("ordinary publication failure rolls back or recovers");
            assert_eq!(recovered, previous, "{failed_stage:?} exposed a torn pair");
        }
    }

    #[test]
    fn config_pair_reader_recovers_a_crash_between_file_publications() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let previous = AppConfigToml {
            local_api_port: Some("1111".to_string()),
            local_api_token: Some("old-secret".to_string()),
            ..AppConfigToml::default()
        };
        write_config_files(&config_path, &secrets_path, &previous).expect("seed config");
        let replacement = AppConfigToml {
            local_api_port: Some("2222".to_string()),
            local_api_token: Some("new-secret".to_string()),
            ..AppConfigToml::default()
        };
        let (public, private) = split_config_for_secrets(&replacement);
        let public_content =
            serialize_config_toml_with_header(&config_path, &public, "# Mindwtr desktop config")
                .expect("serialize public");
        let private_content =
            serialize_config_toml_with_header(&secrets_path, &private, "# Mindwtr desktop secrets")
                .expect("serialize private");
        restore_optional_file(
            &config_rollback_path(&config_path),
            read_optional_bytes(&config_path).unwrap().as_deref(),
            true,
        )
        .unwrap();
        restore_optional_file(
            &config_rollback_path(&secrets_path),
            read_optional_bytes(&secrets_path).unwrap().as_deref(),
            true,
        )
        .unwrap();
        let state_path = config_credential_state_path_from_secrets_path(&secrets_path);
        let mut state = read_config_credential_state_file(&state_path)
            .unwrap()
            .expect("state exists");
        state.pending_config = Some(ConfigPublicationPending {
            generation: state.config_generation + 1,
            config_fingerprint: Some(fingerprint_bytes(public_content.as_bytes())),
            secrets_fingerprint: Some(fingerprint_bytes(private_content.as_bytes())),
        });
        write_config_credential_state_file(&state_path, &state).unwrap();
        write_atomic_text(&config_path, &public_content, false).unwrap();

        let recovered = read_config_files_verified(&config_path, &secrets_path)
            .expect("partial generation recovers from durable backups");
        assert_eq!(recovered, previous);
    }

    #[test]
    fn sync_backend_reader_recovers_config_pair_before_reconciling_marker() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let dropbox_state_path = dir.path().join(DROPBOX_CREDENTIAL_STATE_FILE_NAME);
        let previous = AppConfigToml {
            sync_backend: Some("off".to_string()),
            local_api_port: Some("1111".to_string()),
            local_api_token: Some("old-secret".to_string()),
            ..AppConfigToml::default()
        };
        write_config_files(&config_path, &secrets_path, &previous).expect("seed config");
        write_dropbox_credential_state_file(
            &dropbox_state_path,
            &DropboxCredentialStateFile::default(),
        )
        .expect("seed backend marker");

        let replacement = AppConfigToml {
            sync_backend: Some("cloud".to_string()),
            local_api_port: Some("2222".to_string()),
            local_api_token: Some("new-secret".to_string()),
            ..AppConfigToml::default()
        };
        let (public, private) = split_config_for_secrets(&replacement);
        let public_content =
            serialize_config_toml_with_header(&config_path, &public, "# Mindwtr desktop config")
                .expect("serialize public");
        let private_content =
            serialize_config_toml_with_header(&secrets_path, &private, "# Mindwtr desktop secrets")
                .expect("serialize private");
        restore_optional_file(
            &config_rollback_path(&config_path),
            read_optional_bytes(&config_path).unwrap().as_deref(),
            true,
        )
        .unwrap();
        restore_optional_file(
            &config_rollback_path(&secrets_path),
            read_optional_bytes(&secrets_path).unwrap().as_deref(),
            true,
        )
        .unwrap();
        let config_state_path = config_credential_state_path_from_secrets_path(&secrets_path);
        let mut config_state = read_config_credential_state_file(&config_state_path)
            .unwrap()
            .expect("state exists");
        config_state.pending_config = Some(ConfigPublicationPending {
            generation: config_state.config_generation + 1,
            config_fingerprint: Some(fingerprint_bytes(public_content.as_bytes())),
            secrets_fingerprint: Some(fingerprint_bytes(private_content.as_bytes())),
        });
        write_config_credential_state_file(&config_state_path, &config_state).unwrap();
        write_atomic_text(&config_path, &public_content, false).unwrap();

        let (raw_backend, _) = read_sync_backend_publication_state_paths_with(
            &config_path,
            &secrets_path,
            &dropbox_state_path,
            || {},
        )
        .expect("backend reader recovers config transaction first");
        let recovered = read_config_files_verified(&config_path, &secrets_path)
            .expect("recovered config remains readable");

        assert_eq!(raw_backend, "off");
        assert_eq!(recovered, previous);
    }

    #[test]
    fn bound_credential_update_never_exposes_a_mixed_endpoint_and_secret() {
        for failed_stage in CredentialPublicationStage::ALL {
            let dir = tempfile::tempdir().expect("tempdir");
            let config_path = dir.path().join("config.toml");
            let secrets_path = dir.path().join("secrets.toml");
            let keyring = std::cell::RefCell::new(None::<String>);
            write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
                .expect("seed config");
            update_bound_credential_paths_with(
                &config_path,
                &secrets_path,
                CredentialService::Webdav,
                CredentialSecretUpdate::Replace(Some("old-password".to_string())),
                |config| {
                    config.webdav_url = Some("https://old.example/dav".to_string());
                    config.webdav_username = Some("alice".to_string());
                },
                || Ok(keyring.borrow().clone()),
                |secret| {
                    *keyring.borrow_mut() = secret;
                    Ok(())
                },
                |_| Ok(()),
            )
            .expect("seed bound credential");

            let result = update_bound_credential_paths_with(
                &config_path,
                &secrets_path,
                CredentialService::Webdav,
                CredentialSecretUpdate::Replace(Some("new-password".to_string())),
                |config| {
                    config.webdav_url = Some("https://new.example/dav".to_string());
                    config.webdav_username = Some("bob".to_string());
                },
                || Ok(keyring.borrow().clone()),
                |secret| {
                    *keyring.borrow_mut() = secret;
                    Ok(())
                },
                |stage| {
                    if stage == failed_stage {
                        Err(format!("injected {stage:?} failure"))
                    } else {
                        Ok(())
                    }
                },
            );
            assert!(
                result.is_err(),
                "{failed_stage:?} must not acknowledge success"
            );

            if let Ok((config, password)) = read_bound_credential_paths_with(
                &config_path,
                &secrets_path,
                CredentialService::Webdav,
                || Ok(keyring.borrow().clone()),
            ) {
                assert_eq!(
                    config.webdav_url.as_deref(),
                    Some("https://old.example/dav")
                );
                assert_eq!(config.webdav_username.as_deref(), Some("alice"));
                assert_eq!(password.as_deref(), Some("old-password"));
            }
        }
    }

    #[test]
    fn bound_credential_uses_private_fallback_when_keyring_is_unavailable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
            .expect("seed config");

        update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            CredentialSecretUpdate::Replace(Some("fallback-token".to_string())),
            |config| config.cloud_url = Some("https://cloud.example".to_string()),
            || Err("keyring unavailable".to_string()),
            |_| Err("keyring unavailable".to_string()),
            |_| Ok(()),
        )
        .expect("plaintext fallback remains a supported transaction");

        let (config, token) = read_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            || Err("keyring unavailable".to_string()),
        )
        .expect("committed fallback binding is readable");
        assert_eq!(config.cloud_url.as_deref(), Some("https://cloud.example"));
        assert_eq!(token.as_deref(), Some("fallback-token"));
        assert!(read_config_toml(&config_path).cloud_token.is_none());
        assert_eq!(
            read_config_toml(&secrets_path).cloud_token.as_deref(),
            Some("fallback-token")
        );
    }

    #[test]
    fn bound_credential_keeps_then_clears_without_trusting_a_stale_keyring_value() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let keyring = std::cell::RefCell::new(None::<String>);
        write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
            .expect("seed config");
        update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Webdav,
            CredentialSecretUpdate::Replace(Some("kept-password".to_string())),
            |config| config.webdav_url = Some("https://old.example".to_string()),
            || Ok(keyring.borrow().clone()),
            |secret| {
                *keyring.borrow_mut() = secret;
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("seed binding");
        update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Webdav,
            CredentialSecretUpdate::Keep,
            |config| config.webdav_url = Some("https://new.example".to_string()),
            || Ok(keyring.borrow().clone()),
            |secret| {
                *keyring.borrow_mut() = secret;
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("rebind kept password to new endpoint");
        let (kept_config, kept_password) = read_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Webdav,
            || Ok(keyring.borrow().clone()),
        )
        .expect("kept binding reads");
        assert_eq!(
            kept_config.webdav_url.as_deref(),
            Some("https://new.example")
        );
        assert_eq!(kept_password.as_deref(), Some("kept-password"));

        update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Webdav,
            CredentialSecretUpdate::Replace(None),
            |config| config.webdav_url = None,
            || Ok(keyring.borrow().clone()),
            |secret| {
                if secret.is_none() {
                    return Err("injected keyring delete failure".to_string());
                }
                *keyring.borrow_mut() = secret;
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("clear commits an absent credential binding");
        assert_eq!(
            keyring.borrow().as_deref(),
            Some("kept-password"),
            "the test keeps a stale keyring value to prove it is non-authoritative"
        );
        let (cleared_config, cleared_password) = read_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Webdav,
            || Ok(keyring.borrow().clone()),
        )
        .expect("cleared binding reads");
        assert!(cleared_config.webdav_url.is_none());
        assert!(cleared_password.is_none());
    }

    // I1: reproduces the lost-update race at the mechanism level (no
    // AppHandle needed — the race lives entirely in which mutex each writer
    // takes, and these are the same raw-path primitives the real command
    // functions call). An RMW-guarded writer (the pre-fix shape of e.g.
    // set_ai_key) reads, then blocks on a channel instead of sleeping — a
    // fixed-duration sleep here was flaky under `cargo test`'s parallel
    // scheduling (this test run alone: passes; run inside the full suite,
    // with dozens of threads contending for CPU: the sleep windows drift and
    // the interleaving this test depends on stops happening). A CRED-only
    // writer (the PRE-FIX shape of set_webdav_config — no outer RMW lock,
    // just what update_bound_credential_paths_with takes internally) runs
    // and fully completes before the RMW writer is released to mutate+write.
    // The RMW writer's write uses its stale snapshot and silently reverts
    // the CRED-only writer's change.
    #[test]
    fn rmw_holder_gap_loses_a_cred_only_writers_update_without_the_outer_rmw_lock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
            .expect("seed config");

        let (read_done_tx, read_done_rx) = std::sync::mpsc::channel::<()>();
        let (proceed_tx, proceed_rx) = std::sync::mpsc::channel::<()>();
        let (rmw_config_path, rmw_secrets_path) = (config_path.clone(), secrets_path.clone());
        let rmw_writer = std::thread::spawn(move || {
            let _guard = lock_config_read_modify_write().expect("rmw lock");
            let mut config = read_config_files_verified(&rmw_config_path, &rmw_secrets_path)
                .expect("read");
            read_done_tx.send(()).expect("signal read done");
            proceed_rx.recv().expect("wait for the cred-only writer to finish");
            config.proxy_url = Some("https://rmw-writer.example".to_string());
            write_config_files(&rmw_config_path, &rmw_secrets_path, &config).expect("write");
        });

        read_done_rx.recv().expect("wait for the rmw writer's read");
        update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Webdav,
            CredentialSecretUpdate::Replace(None),
            |config| config.webdav_url = Some("https://cred-writer.example".to_string()),
            || Ok(None),
            |_| Ok(()),
            |_| Ok(()),
        )
        .expect("cred-only writer completes");
        proceed_tx.send(()).expect("let the rmw writer proceed");

        rmw_writer.join().expect("rmw writer thread");

        let final_config = read_config_toml(&config_path);
        assert_eq!(
            final_config.proxy_url.as_deref(),
            Some("https://rmw-writer.example")
        );
        assert_eq!(
            final_config.webdav_url, None,
            "demonstrates the bug: the CRED-only writer's change is gone, \
             reverted by the RMW holder's stale-snapshot write"
        );
    }

    // Same race as above, but the CRED-only side now also takes the outer
    // RMW lock first — the FIXED shape of set_webdav_config/set_cloud_config/
    // set_sync_backend/get_sync_backend/get_sync_cloud_provider(_state)/
    // get_sync_configuration_snapshot (I1). Both changes must survive. This
    // one needs no timing coordination at all: the mutex fully serializes
    // the two writers regardless of which reaches lock_config_read_modify_write
    // first, so the assertions hold either way.
    #[test]
    fn outer_rmw_lock_on_both_sides_prevents_the_lost_update() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
            .expect("seed config");

        let (rmw_config_path, rmw_secrets_path) = (config_path.clone(), secrets_path.clone());
        let rmw_writer = std::thread::spawn(move || {
            let _guard = lock_config_read_modify_write().expect("rmw lock");
            let mut config = read_config_files_verified(&rmw_config_path, &rmw_secrets_path)
                .expect("read");
            config.proxy_url = Some("https://rmw-writer.example".to_string());
            write_config_files(&rmw_config_path, &rmw_secrets_path, &config).expect("write");
        });

        let (cred_config_path, cred_secrets_path) = (config_path.clone(), secrets_path.clone());
        let cred_writer = std::thread::spawn(move || {
            let _guard = lock_config_read_modify_write().expect("rmw lock");
            update_bound_credential_paths_with(
                &cred_config_path,
                &cred_secrets_path,
                CredentialService::Webdav,
                CredentialSecretUpdate::Replace(None),
                |config| config.webdav_url = Some("https://cred-writer.example".to_string()),
                || Ok(None),
                |_| Ok(()),
                |_| Ok(()),
            )
        });

        rmw_writer.join().expect("rmw writer thread");
        cred_writer
            .join()
            .expect("cred writer thread")
            .expect("cred-only writer completes");

        let final_config = read_config_toml(&config_path);
        assert_eq!(
            final_config.proxy_url.as_deref(),
            Some("https://rmw-writer.example")
        );
        assert_eq!(
            final_config.webdav_url.as_deref(),
            Some("https://cred-writer.example"),
            "both writers' changes must survive once both take the outer RMW lock"
        );
    }

    #[cfg(unix)]
    #[test]
    fn credential_binding_state_is_owner_only_and_contains_no_endpoint_or_secret_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let keyring = std::cell::RefCell::new(None::<String>);
        write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
            .expect("seed config");
        update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            CredentialSecretUpdate::Replace(Some("never-persist-this-token".to_string())),
            |config| config.cloud_url = Some("https://private-endpoint.example".to_string()),
            || Ok(keyring.borrow().clone()),
            |secret| {
                *keyring.borrow_mut() = secret;
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("commit binding");

        let state_path = config_credential_state_path_from_secrets_path(&secrets_path);
        let raw = fs::read_to_string(&state_path).expect("read state");
        assert!(!raw.contains("never-persist-this-token"));
        assert!(!raw.contains("private-endpoint.example"));
        assert_eq!(
            fs::metadata(&state_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn bound_credential_reader_fails_closed_after_endpoint_only_change() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let keyring = std::cell::RefCell::new(None::<String>);
        write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
            .expect("seed config");
        let mut committed = update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            CredentialSecretUpdate::Replace(Some("cloud-token".to_string())),
            |config| config.cloud_url = Some("https://trusted.example".to_string()),
            || Ok(keyring.borrow().clone()),
            |secret| {
                *keyring.borrow_mut() = secret;
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("commit binding");
        committed.cloud_url = Some("https://wrong.example".to_string());
        write_config_files(&config_path, &secrets_path, &committed)
            .expect("publish unrelated whole-config snapshot");

        let result = read_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            || Ok(keyring.borrow().clone()),
        );
        assert!(
            result.is_err(),
            "a stale token must never reach the changed endpoint"
        );
    }

    #[test]
    fn bound_credential_reader_rejects_an_interrupted_pending_generation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let keyring = std::cell::RefCell::new(None::<String>);
        write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
            .expect("seed config");
        let committed = update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            CredentialSecretUpdate::Replace(Some("old-token".to_string())),
            |config| config.cloud_url = Some("https://old.example".to_string()),
            || Ok(keyring.borrow().clone()),
            |secret| {
                *keyring.borrow_mut() = secret;
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("commit binding");
        let mut interrupted = committed;
        interrupted.cloud_url = Some("https://new.example".to_string());
        let state_path = config_credential_state_path_from_secrets_path(&secrets_path);
        let mut state = read_config_credential_state_file(&state_path)
            .unwrap()
            .expect("state exists");
        state.pending_credential = Some(CredentialBindingPending {
            service: CredentialService::Cloud.state_key().to_string(),
            generation: state.credential_generation + 1,
            endpoint_fingerprint: endpoint_fingerprint(CredentialService::Cloud, &interrupted),
            credential_fingerprint: credential_fingerprint(Some("new-token")),
        });
        write_config_credential_state_file(&state_path, &state).unwrap();
        *keyring.borrow_mut() = Some("new-token".to_string());

        assert!(read_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            || Ok(keyring.borrow().clone()),
        )
        .is_err());
    }

    #[test]
    fn bound_credential_reader_reconciles_exact_crash_stages() {
        for old_password in [Some("old-password"), None] {
            for crash_stage in CredentialPublicationStage::ALL {
                let dir = tempfile::tempdir().expect("tempdir");
                let config_path = dir.path().join("config.toml");
                let secrets_path = dir.path().join("secrets.toml");
                let keyring = std::cell::RefCell::new(None::<String>);
                write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
                    .expect("seed config");
                let committed = update_bound_credential_paths_with(
                    &config_path,
                    &secrets_path,
                    CredentialService::Webdav,
                    CredentialSecretUpdate::Replace(old_password.map(str::to_string)),
                    |config| config.webdav_url = Some("https://old.example/dav".to_string()),
                    || Ok(keyring.borrow().clone()),
                    |secret| {
                        *keyring.borrow_mut() = secret;
                        Ok(())
                    },
                    |_| Ok(()),
                )
                .expect("seed committed binding");
                let mut target = committed;
                target.webdav_url = Some("https://new.example/dav".to_string());
                let target_endpoint = endpoint_fingerprint(CredentialService::Webdav, &target);
                let target_credential = credential_fingerprint(Some("new-password"));
                let state_path = config_credential_state_path_from_secrets_path(&secrets_path);
                let mut state = read_config_credential_state_file(&state_path)
                    .unwrap()
                    .expect("state exists");
                let target_generation = state.credential_generation + 1;
                state.pending_credential = Some(CredentialBindingPending {
                    service: CredentialService::Webdav.state_key().to_string(),
                    generation: target_generation,
                    endpoint_fingerprint: target_endpoint.clone(),
                    credential_fingerprint: target_credential.clone(),
                });
                write_config_credential_state_file(&state_path, &state).unwrap();

                if crash_stage != CredentialPublicationStage::PendingState {
                    *keyring.borrow_mut() = Some("new-password".to_string());
                }
                if matches!(
                    crash_stage,
                    CredentialPublicationStage::ConfigPair
                        | CredentialPublicationStage::ReadBack
                        | CredentialPublicationStage::CommittedState
                ) {
                    write_config_files(&config_path, &secrets_path, &target)
                        .expect("publish target config pair");
                }
                if crash_stage == CredentialPublicationStage::CommittedState {
                    let mut state = read_config_credential_state_file(&state_path)
                        .unwrap()
                        .expect("state exists");
                    state.credential_generation = target_generation;
                    state.bindings.insert(
                        CredentialService::Webdav.state_key().to_string(),
                        CredentialBinding {
                            generation: target_generation,
                            endpoint_fingerprint: target_endpoint,
                            credential_fingerprint: target_credential,
                        },
                    );
                    state.pending_credential = None;
                    write_config_credential_state_file(&state_path, &state).unwrap();
                }

                let result = read_bound_credential_paths_with(
                    &config_path,
                    &secrets_path,
                    CredentialService::Webdav,
                    || Ok(keyring.borrow().clone()),
                );
                if crash_stage == CredentialPublicationStage::SecretStore {
                    assert!(result.is_err(), "{crash_stage:?} must remain fail-closed");
                } else {
                    let (config, password) = result.expect("exact generation reconciles");
                    let expected_endpoint =
                        if crash_stage == CredentialPublicationStage::PendingState {
                            "https://old.example/dav"
                        } else {
                            "https://new.example/dav"
                        };
                    let expected_password =
                        if crash_stage == CredentialPublicationStage::PendingState {
                            old_password
                        } else {
                            Some("new-password")
                        };
                    assert_eq!(config.webdav_url.as_deref(), Some(expected_endpoint));
                    assert_eq!(password.as_deref(), expected_password);
                }

                let recovered_state = read_config_credential_state_file(&state_path)
                    .unwrap()
                    .expect("state exists");
                assert_eq!(
                    recovered_state.pending_credential.is_some(),
                    crash_stage == CredentialPublicationStage::SecretStore,
                    "{crash_stage:?} pending state"
                );
            }
        }
    }

    #[test]
    fn pending_email_and_webdav_updates_do_not_block_committed_cloud_transport() {
        for pending_service in [CredentialService::Email, CredentialService::Webdav] {
            let dir = tempfile::tempdir().expect("tempdir");
            let config_path = dir.path().join("config.toml");
            let secrets_path = dir.path().join("secrets.toml");
            let cloud_keyring = std::cell::RefCell::new(None::<String>);
            let pending_keyring = std::cell::RefCell::new(None::<String>);
            write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
                .expect("seed config");
            update_bound_credential_paths_with(
                &config_path,
                &secrets_path,
                CredentialService::Cloud,
                CredentialSecretUpdate::Replace(Some("cloud-token".to_string())),
                |config| config.cloud_url = Some("https://cloud.example".to_string()),
                || Ok(cloud_keyring.borrow().clone()),
                |secret| {
                    *cloud_keyring.borrow_mut() = secret;
                    Ok(())
                },
                |_| Ok(()),
            )
            .expect("seed cloud binding");
            let committed = update_bound_credential_paths_with(
                &config_path,
                &secrets_path,
                pending_service,
                CredentialSecretUpdate::Replace(Some("old-service-secret".to_string())),
                |config| match pending_service {
                    CredentialService::Email => {
                        config.email_capture_config =
                            Some(r#"{"enabled":true,"email":"old@example.com"}"#.to_string())
                    }
                    CredentialService::Webdav => {
                        config.webdav_url = Some("https://old.example/dav".to_string())
                    }
                    CredentialService::Cloud => unreachable!(),
                },
                || Ok(pending_keyring.borrow().clone()),
                |secret| {
                    *pending_keyring.borrow_mut() = secret;
                    Ok(())
                },
                |_| Ok(()),
            )
            .expect("seed service binding");
            let mut target = committed;
            match pending_service {
                CredentialService::Email => {
                    target.email_capture_config =
                        Some(r#"{"enabled":true,"email":"new@example.com"}"#.to_string())
                }
                CredentialService::Webdav => {
                    target.webdav_url = Some("https://new.example/dav".to_string())
                }
                CredentialService::Cloud => unreachable!(),
            }
            let state_path = config_credential_state_path_from_secrets_path(&secrets_path);
            let mut state = read_config_credential_state_file(&state_path)
                .unwrap()
                .expect("state exists");
            state.pending_credential = Some(CredentialBindingPending {
                service: pending_service.state_key().to_string(),
                generation: state.credential_generation + 1,
                endpoint_fingerprint: endpoint_fingerprint(pending_service, &target),
                credential_fingerprint: credential_fingerprint(Some("new-service-secret")),
            });
            write_config_credential_state_file(&state_path, &state).unwrap();
            *pending_keyring.borrow_mut() = Some("new-service-secret".to_string());

            assert!(read_bound_credential_paths_with(
                &config_path,
                &secrets_path,
                pending_service,
                || Ok(pending_keyring.borrow().clone()),
            )
            .is_err());
            let (cloud_config, cloud_token) = read_bound_credential_paths_with(
                &config_path,
                &secrets_path,
                CredentialService::Cloud,
                || Ok(cloud_keyring.borrow().clone()),
            )
            .expect("unrelated committed cloud binding stays readable");
            assert_eq!(
                cloud_config.cloud_url.as_deref(),
                Some("https://cloud.example")
            );
            assert_eq!(cloud_token.as_deref(), Some("cloud-token"));
            assert_eq!(
                read_config_credential_state_file(&state_path)
                    .unwrap()
                    .expect("state exists")
                    .pending_credential
                    .as_ref()
                    .map(|pending| pending.service.as_str()),
                Some(pending_service.state_key())
            );
        }
    }

    #[test]
    fn unbound_cloud_read_does_not_invalidate_exact_pending_email_recovery() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let email_keyring = std::cell::RefCell::new(None::<String>);
        write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
            .expect("seed config");
        let committed = update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Email,
            CredentialSecretUpdate::Replace(Some("old-email-secret".to_string())),
            |config| {
                config.email_capture_config =
                    Some(r#"{"enabled":true,"email":"old@example.com"}"#.to_string())
            },
            || Ok(email_keyring.borrow().clone()),
            |secret| {
                *email_keyring.borrow_mut() = secret;
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("seed email binding");

        let mut target = committed;
        target.email_capture_config =
            Some(r#"{"enabled":true,"email":"new@example.com"}"#.to_string());
        let state_path = config_credential_state_path_from_secrets_path(&secrets_path);
        let mut state = read_config_credential_state_file(&state_path)
            .unwrap()
            .expect("state exists");
        let pending_generation = state.credential_generation + 1;
        state.pending_credential = Some(CredentialBindingPending {
            service: CredentialService::Email.state_key().to_string(),
            generation: pending_generation,
            endpoint_fingerprint: endpoint_fingerprint(CredentialService::Email, &target),
            credential_fingerprint: credential_fingerprint(Some("new-email-secret")),
        });
        write_config_credential_state_file(&state_path, &state).unwrap();
        *email_keyring.borrow_mut() = Some("new-email-secret".to_string());
        write_config_files(&config_path, &secrets_path, &target)
            .expect("publish exact pending email target");

        let (_, cloud_token) = read_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            || Ok(None),
        )
        .expect("unbound cloud transport remains readable");
        assert_eq!(cloud_token, None);
        let interleaved_state = read_config_credential_state_file(&state_path)
            .unwrap()
            .expect("state exists");
        assert_eq!(
            interleaved_state.credential_generation,
            state.credential_generation
        );
        assert_eq!(
            interleaved_state
                .pending_credential
                .as_ref()
                .map(|pending| pending.generation),
            Some(pending_generation)
        );

        let (recovered_config, recovered_secret) = read_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Email,
            || Ok(email_keyring.borrow().clone()),
        )
        .expect("exact pending email target recovers after unrelated cloud read");
        assert_eq!(
            recovered_config.email_capture_config,
            target.email_capture_config
        );
        assert_eq!(recovered_secret.as_deref(), Some("new-email-secret"));

        let recovered_state = read_config_credential_state_file(&state_path)
            .unwrap()
            .expect("state exists");
        assert!(recovered_state.pending_credential.is_none());
        assert_eq!(
            recovered_state
                .bindings
                .get(CredentialService::Email.state_key())
                .map(|binding| binding.generation),
            Some(pending_generation)
        );
        assert!(recovered_state
            .bindings
            .contains_key(CredentialService::Cloud.state_key()));
    }

    #[test]
    fn legacy_dropbox_fields_migrate_to_dedicated_state_before_they_are_scrubbed() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let state_path = dir.path().join(DROPBOX_CREDENTIAL_STATE_FILE_NAME);
        let public_config = AppConfigToml {
            sync_backend: Some("cloud".to_string()),
            sync_cloud_provider: Some("dropbox".to_string()),
            local_api_port: Some("3456".to_string()),
            ..AppConfigToml::default()
        };
        let legacy_secrets = AppConfigToml {
            dropbox_tokens: Some("legacy-dropbox-token-bundle".to_string()),
            dropbox_promotion_journal: Some("legacy-promotion-journal".to_string()),
            local_api_token: Some("unrelated-local-api-token".to_string()),
            ..AppConfigToml::default()
        };
        write_config_toml(&config_path, &public_config).expect("write legacy public config");
        write_secrets_toml(&secrets_path, &legacy_secrets).expect("write legacy secrets");

        let migrated = load_or_migrate_dropbox_credential_state_paths_unlocked(
            &config_path,
            &secrets_path,
            &state_path,
        )
        .expect("migrate dedicated Dropbox authority");

        assert_eq!(
            migrated.token_fallback.as_deref(),
            Some("legacy-dropbox-token-bundle")
        );
        assert_eq!(
            migrated.promotion_journal.as_deref(),
            Some("legacy-promotion-journal")
        );
        assert_eq!(migrated.sync_backend_marker, "cloud");
        assert_eq!(migrated.cloud_provider, "selfhosted");
        assert_eq!(migrated.cloud_provider_authority, "uninitialized");
        assert_eq!(
            read_dropbox_credential_state_file(&state_path)
                .expect("read dedicated state")
                .expect("dedicated state exists"),
            migrated
        );

        let scrubbed_public = read_config_toml(&config_path);
        let scrubbed_secrets = read_config_toml(&secrets_path);
        assert_eq!(scrubbed_public.dropbox_tokens, None);
        assert_eq!(scrubbed_public.dropbox_promotion_journal, None);
        assert_eq!(scrubbed_secrets.dropbox_tokens, None);
        assert_eq!(scrubbed_secrets.dropbox_promotion_journal, None);
        assert_eq!(
            scrubbed_secrets.local_api_token.as_deref(),
            Some("unrelated-local-api-token")
        );
        assert_eq!(scrubbed_public.local_api_port.as_deref(), Some("3456"));
    }

    #[test]
    fn stale_whole_config_write_cannot_resurrect_dedicated_dropbox_authority() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let state_path = dir.path().join(DROPBOX_CREDENTIAL_STATE_FILE_NAME);
        let dedicated = DropboxCredentialStateFile {
            token_fallback: Some("current-candidate-token-bundle".to_string()),
            promotion_journal: Some("current-promotion-journal".to_string()),
            sync_backend_marker: "cloud".to_string(),
            cloud_provider: "dropbox".to_string(),
            cloud_provider_authority: "native".to_string(),
            generation: 7,
            ..DropboxCredentialStateFile::default()
        };
        write_dropbox_credential_state_file(&state_path, &dedicated)
            .expect("publish dedicated authority");

        let stale_snapshot = AppConfigToml {
            sync_backend: Some("off".to_string()),
            dropbox_tokens: Some("stale-previous-token-bundle".to_string()),
            dropbox_promotion_journal: Some("stale-promotion-journal".to_string()),
            local_api_port: Some("4567".to_string()),
            local_api_token: Some("unrelated-local-api-token".to_string()),
            ..AppConfigToml::default()
        };
        write_config_files(&config_path, &secrets_path, &stale_snapshot)
            .expect("persist unrelated stale-snapshot change");

        assert_eq!(
            read_dropbox_credential_state_file(&state_path)
                .expect("read dedicated state")
                .expect("dedicated state remains"),
            dedicated,
            "a generic config write must not overwrite the transaction authority"
        );
        let public = read_config_toml(&config_path);
        let secrets = read_config_toml(&secrets_path);
        assert_eq!(public.local_api_port.as_deref(), Some("4567"));
        assert_eq!(
            secrets.local_api_token.as_deref(),
            Some("unrelated-local-api-token")
        );
        assert_eq!(secrets.dropbox_tokens, None);
        assert_eq!(secrets.dropbox_promotion_journal, None);
        let raw_secrets = fs::read_to_string(&secrets_path).expect("read scrubbed secrets");
        assert!(!raw_secrets.contains("stale-previous-token-bundle"));
        assert!(!raw_secrets.contains("stale-promotion-journal"));
    }

    #[test]
    fn backend_publication_excludes_stale_whole_config_writes_from_the_raw_marker_gap() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let state_path = dir.path().join(DROPBOX_CREDENTIAL_STATE_FILE_NAME);
        let initial = AppConfigToml {
            sync_backend: Some("off".to_string()),
            local_api_port: Some("3456".to_string()),
            ..AppConfigToml::default()
        };
        write_config_toml(&config_path, &initial).expect("write initial config");
        write_dropbox_credential_state_file(&state_path, &DropboxCredentialStateFile::default())
            .expect("write initial marker");

        let (raw_ready_tx, raw_ready_rx) = std::sync::mpsc::channel();
        let (finish_publication_tx, finish_publication_rx) = std::sync::mpsc::channel();
        let publication_config_path = config_path.clone();
        let publication_secrets_path = secrets_path.clone();
        let publication_state_path = state_path.clone();
        let publisher = std::thread::spawn(move || {
            publish_sync_backend_paths_with(
                &publication_config_path,
                &publication_secrets_path,
                &publication_state_path,
                "cloud",
                || {
                    raw_ready_tx.send(()).expect("signal raw publication");
                    finish_publication_rx
                        .recv()
                        .expect("resume marker publication");
                    Ok(())
                },
            )
        });

        raw_ready_rx.recv().expect("raw backend reached disk");
        assert_eq!(
            read_config_toml_optional_strict(&config_path)
                .expect("read raw config")
                .sync_backend
                .as_deref(),
            Some("cloud")
        );
        assert_eq!(
            read_dropbox_credential_state_file(&state_path)
                .expect("read marker")
                .expect("marker exists")
                .sync_backend_marker,
            "off",
            "the hook pauses in the former raw/marker gap"
        );
        assert!(matches!(
            DROPBOX_CREDENTIAL_STATE_MUTEX.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));

        let stale_config_path = config_path.clone();
        let stale_secrets_path = secrets_path.clone();
        let stale_writer = std::thread::spawn(move || {
            let stale = AppConfigToml {
                sync_backend: Some("off".to_string()),
                local_api_port: Some("4567".to_string()),
                ..AppConfigToml::default()
            };
            write_config_files(&stale_config_path, &stale_secrets_path, &stale)
        });

        finish_publication_tx
            .send(())
            .expect("finish backend publication");
        publisher
            .join()
            .expect("publisher thread should not panic")
            .expect("backend publication should succeed");
        stale_writer
            .join()
            .expect("stale writer thread should not panic")
            .expect("stale whole-config write should succeed after publication");

        let persisted = read_config_toml_optional_strict(&config_path).expect("read final config");
        let marker = read_dropbox_credential_state_file(&state_path)
            .expect("read final marker")
            .expect("final marker exists");
        assert_eq!(persisted.sync_backend.as_deref(), Some("cloud"));
        assert_eq!(marker.sync_backend_marker, "cloud");
        assert_eq!(persisted.local_api_port.as_deref(), Some("4567"));
    }

    #[test]
    fn torn_backend_publication_reconciles_to_the_committed_marker() {
        for (committed, attempted, has_journal) in [
            ("off", "cloud", false),
            ("off", "cloud", true),
            ("cloud", "off", false),
            ("cloud", "off", true),
        ] {
            let dir = tempfile::tempdir().expect("should create temp dir");
            let config_path = dir.path().join("config.toml");
            let secrets_path = dir.path().join("secrets.toml");
            let state_path = dir.path().join(DROPBOX_CREDENTIAL_STATE_FILE_NAME);
            write_config_toml(
                &config_path,
                &AppConfigToml {
                    sync_backend: Some(committed.to_string()),
                    local_api_port: Some("3456".to_string()),
                    ..AppConfigToml::default()
                },
            )
            .expect("write committed config");
            let committed_state = DropboxCredentialStateFile {
                promotion_journal: has_journal.then(|| "pending-journal".to_string()),
                sync_backend_marker: committed.to_string(),
                cloud_provider: if committed == "cloud" {
                    "dropbox".to_string()
                } else {
                    "selfhosted".to_string()
                },
                cloud_provider_authority: "native".to_string(),
                ..DropboxCredentialStateFile::default()
            };
            write_dropbox_credential_state_file(&state_path, &committed_state)
                .expect("write committed marker");

            let error = publish_sync_backend_paths_with(
                &config_path,
                &secrets_path,
                &state_path,
                attempted,
                || Err("injected process stop after raw read-back".to_string()),
            )
            .expect_err("injected stop prevents marker publication");
            assert!(error.contains("injected process stop"));
            assert_eq!(
                read_raw_sync_backend_path_unlocked(&config_path)
                    .expect("raw attempted backend remains after stop"),
                attempted
            );
            assert_eq!(
                read_dropbox_credential_state_file(&state_path)
                    .expect("read committed marker")
                    .expect("committed marker exists")
                    .sync_backend_marker,
                committed
            );

            let (raw, reconciled_state) = read_sync_backend_publication_state_paths_with(
                &config_path,
                &secrets_path,
                &state_path,
                || {},
            )
            .expect("the next backend read reconciles the torn publication");
            assert_eq!(raw, committed);
            assert_eq!(reconciled_state.sync_backend_marker, committed);
            assert_eq!(
                reconciled_state.promotion_journal.is_some(),
                has_journal,
                "reconciliation must not consume credential recovery state"
            );

            let ((snapshot, _, _), snapshot_state) = read_sync_configuration_pair_paths_with(
                &config_path,
                &secrets_path,
                &state_path,
                || {},
            )
            .expect("snapshot observes the stable committed pair");
            assert_eq!(snapshot.sync_backend.as_deref(), Some(committed));
            assert_eq!(snapshot_state.sync_backend_marker, committed);
            assert_eq!(
                snapshot.local_api_port.as_deref(),
                Some("3456"),
                "field-level reconciliation preserves unrelated config"
            );
        }
    }

    #[test]
    fn sync_configuration_snapshot_reads_one_atomic_raw_marker_pair() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let state_path = dir.path().join(DROPBOX_CREDENTIAL_STATE_FILE_NAME);
        write_config_toml(
            &config_path,
            &AppConfigToml {
                sync_backend: Some("off".to_string()),
                ..AppConfigToml::default()
            },
        )
        .expect("write initial config");
        write_dropbox_credential_state_file(&state_path, &DropboxCredentialStateFile::default())
            .expect("write initial marker");

        let (marker_read_tx, marker_read_rx) = std::sync::mpsc::channel();
        let (finish_snapshot_tx, finish_snapshot_rx) = std::sync::mpsc::channel();
        let snapshot_config_path = config_path.clone();
        let snapshot_secrets_path = secrets_path.clone();
        let snapshot_state_path = state_path.clone();
        let reader = std::thread::spawn(move || {
            read_sync_configuration_pair_paths_with(
                &snapshot_config_path,
                &snapshot_secrets_path,
                &snapshot_state_path,
                || {
                    marker_read_tx.send(()).expect("signal marker read");
                    finish_snapshot_rx.recv().expect("resume snapshot read");
                },
            )
        });

        marker_read_rx.recv().expect("snapshot read marker");
        let writer_config_path = config_path.clone();
        let writer_secrets_path = secrets_path.clone();
        let writer_state_path = state_path.clone();
        let writer = std::thread::spawn(move || {
            publish_sync_backend_paths_with(
                &writer_config_path,
                &writer_secrets_path,
                &writer_state_path,
                "cloud",
                || Ok(()),
            )
        });
        assert!(matches!(
            DROPBOX_CREDENTIAL_STATE_MUTEX.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        finish_snapshot_tx.send(()).expect("finish snapshot read");

        let ((config, _, _), state) = reader
            .join()
            .expect("reader thread should not panic")
            .expect("snapshot pair should read");
        writer
            .join()
            .expect("writer thread should not panic")
            .expect("backend publication should finish");
        assert_eq!(config.sync_backend.as_deref(), Some("off"));
        assert_eq!(state.sync_backend_marker, "off");
    }

    #[test]
    fn dropbox_commit_state_reads_one_atomic_raw_marker_pair() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let state_path = dir.path().join(DROPBOX_CREDENTIAL_STATE_FILE_NAME);
        write_config_toml(
            &config_path,
            &AppConfigToml {
                sync_backend: Some("off".to_string()),
                ..AppConfigToml::default()
            },
        )
        .expect("write initial config");
        write_dropbox_credential_state_file(&state_path, &DropboxCredentialStateFile::default())
            .expect("write initial marker");

        let (raw_read_tx, raw_read_rx) = std::sync::mpsc::channel();
        let (finish_commit_read_tx, finish_commit_read_rx) = std::sync::mpsc::channel();
        let read_config_path = config_path.clone();
        let read_secrets_path = secrets_path.clone();
        let read_state_path = state_path.clone();
        let reader = std::thread::spawn(move || {
            read_sync_backend_publication_state_paths_with(
                &read_config_path,
                &read_secrets_path,
                &read_state_path,
                || {
                    raw_read_tx.send(()).expect("signal raw read");
                    finish_commit_read_rx
                        .recv()
                        .expect("resume commit-state read");
                },
            )
        });

        raw_read_rx.recv().expect("commit state read raw backend");
        let writer_config_path = config_path.clone();
        let writer_secrets_path = secrets_path.clone();
        let writer_state_path = state_path.clone();
        let writer = std::thread::spawn(move || {
            publish_sync_backend_paths_with(
                &writer_config_path,
                &writer_secrets_path,
                &writer_state_path,
                "cloud",
                || Ok(()),
            )
        });
        assert!(matches!(
            DROPBOX_CREDENTIAL_STATE_MUTEX.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        finish_commit_read_tx
            .send(())
            .expect("finish commit-state read");

        let (raw_backend, state) = reader
            .join()
            .expect("reader thread should not panic")
            .expect("commit-state pair should read");
        writer
            .join()
            .expect("writer thread should not panic")
            .expect("backend publication should finish");
        assert_eq!(raw_backend, "off");
        assert_eq!(state.sync_backend_marker, "off");
    }

    #[cfg(unix)]
    #[test]
    fn dedicated_dropbox_state_is_owner_only_on_create_and_overwrite() {
        let dir = tempfile::tempdir().expect("should create temp dir");
        let state_path = dir.path().join(DROPBOX_CREDENTIAL_STATE_FILE_NAME);
        let mut state = DropboxCredentialStateFile {
            token_fallback: Some("private-token-bundle".to_string()),
            ..DropboxCredentialStateFile::default()
        };

        write_dropbox_credential_state_file(&state_path, &state).expect("write dedicated state");
        fs::set_permissions(&state_path, fs::Permissions::from_mode(0o644))
            .expect("loosen state file to simulate an older build");
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755))
            .expect("loosen state directory to simulate an older build");
        state.generation = 1;
        write_dropbox_credential_state_file(&state_path, &state)
            .expect("overwrite dedicated state securely");

        let file_mode = fs::metadata(&state_path)
            .expect("state metadata")
            .permissions()
            .mode()
            & 0o777;
        let directory_mode = fs::metadata(dir.path())
            .expect("state directory metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(file_mode, 0o600);
        assert_eq!(directory_mode, 0o700);
        assert_eq!(
            read_dropbox_credential_state_file(&state_path)
                .expect("read state")
                .expect("state exists"),
            state
        );
    }

    // #1043: a Flatpak/NixOS profile has no Secret Service at all, so every
    // keyring read AND write errors. The whole first-setup sequence — the
    // settings snapshot, the activation commit, and the native sync read that
    // follows it — has to survive on the secrets.toml fallback alone.
    #[test]
    fn keyring_less_first_setup_commits_and_resolves_through_the_secrets_fallback() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let dropbox_state_path = dropbox_credential_state_path_from_secrets_path(&secrets_path);
        let keyring_read = || Err("keyring unavailable".to_string());
        let keyring_write = |_: Option<String>| Err("keyring unavailable".to_string());

        // Opening sync settings resolves BOTH services. Neither has a binding
        // yet, so an intolerant snapshot fails the whole screen (and every
        // auto-sync eligibility check) before any backend can be configured.
        for service in [CredentialService::Webdav, CredentialService::Cloud] {
            let config = read_config_files_verified(&config_path, &secrets_path).unwrap_or_default();
            assert_eq!(
                resolve_sync_snapshot_secret_unlocked(
                    &config_path,
                    &secrets_path,
                    &config,
                    service,
                    keyring_read(),
                )
                .expect("an unconfigured service must not fail the snapshot"),
                SyncSnapshotSecret::Opaque,
            );
        }

        // The activation transaction: disable, write the proven candidate,
        // verify its secret reads back exactly, then activate.
        publish_sync_backend_paths_with(
            &config_path,
            &secrets_path,
            &dropbox_state_path,
            "off",
            || Ok(()),
        )
        .expect("disable sync before mutating credentials");
        update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Webdav,
            CredentialSecretUpdate::Replace(Some("dav-password".to_string())),
            |config| {
                config.webdav_url = Some("https://dav.example/mindwtr".to_string());
                config.webdav_username = Some("dav-user".to_string());
                config.webdav_allow_insecure_http = Some("false".to_string());
            },
            keyring_read,
            keyring_write,
            |_| Ok(()),
        )
        .expect("first save must commit through the fallback");
        let committed =
            read_config_files_verified(&config_path, &secrets_path).expect("read committed config");
        assert_eq!(
            resolve_sync_snapshot_secret_unlocked(
                &config_path,
                &secrets_path,
                &committed,
                CredentialService::Webdav,
                keyring_read(),
            )
            .expect("verification snapshot"),
            SyncSnapshotSecret::Known("dav-password".to_string()),
        );
        publish_sync_backend_paths_with(
            &config_path,
            &secrets_path,
            &dropbox_state_path,
            "webdav",
            || Ok(()),
        )
        .expect("activate the proven backend");

        // What every later native sync request does (webdav_get_json).
        let (config, password) = read_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Webdav,
            keyring_read,
        )
        .expect("native sync must resolve the committed credential");
        assert_eq!(
            config.webdav_url.as_deref(),
            Some("https://dav.example/mindwtr")
        );
        assert_eq!(password.as_deref(), Some("dav-password"));
        assert_eq!(
            read_config_toml(&secrets_path).webdav_password.as_deref(),
            Some("dav-password"),
        );
    }

    // #1043 follow-on: the keyring held the secret when it was saved and later
    // stopped answering. The binding stays fail-closed (it must not silently
    // fall back to a weaker authority), but re-entering the secret has to be a
    // way out rather than a dead end.
    #[test]
    fn reentered_secret_recommits_a_binding_whose_authority_disappeared() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        let secrets_path = dir.path().join("secrets.toml");
        let keyring = std::cell::RefCell::new(None::<String>);
        write_config_files(&config_path, &secrets_path, &AppConfigToml::default())
            .expect("seed config");
        update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            CredentialSecretUpdate::Replace(Some("first-token".to_string())),
            |config| config.cloud_url = Some("https://cloud.example".to_string()),
            || Ok(keyring.borrow().clone()),
            |secret| {
                *keyring.borrow_mut() = secret;
                Ok(())
            },
            |_| Ok(()),
        )
        .expect("seed a keyring-backed binding");
        assert!(read_config_toml(&secrets_path).cloud_token.is_none());

        let dead_keyring = || Err("keyring unavailable".to_string());
        let config = read_config_files_verified(&config_path, &secrets_path).expect("read config");
        assert_eq!(
            resolve_sync_snapshot_secret_unlocked(
                &config_path,
                &secrets_path,
                &config,
                CredentialService::Cloud,
                dead_keyring(),
            )
            .expect("an unreadable authority stays opaque"),
            SyncSnapshotSecret::Opaque,
        );
        assert!(read_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            dead_keyring,
        )
        .is_err());

        update_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            CredentialSecretUpdate::Replace(Some("re-entered-token".to_string())),
            |config| config.cloud_url = Some("https://cloud.example".to_string()),
            dead_keyring,
            |_| Err("keyring unavailable".to_string()),
            |_| Ok(()),
        )
        .expect("a re-entered secret replaces an unreadable binding");

        let (config, token) = read_bound_credential_paths_with(
            &config_path,
            &secrets_path,
            CredentialService::Cloud,
            dead_keyring,
        )
        .expect("the re-entered credential resolves");
        assert_eq!(config.cloud_url.as_deref(), Some("https://cloud.example"));
        assert_eq!(token.as_deref(), Some("re-entered-token"));
    }
}
