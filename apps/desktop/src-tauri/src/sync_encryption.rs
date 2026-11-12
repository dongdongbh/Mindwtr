use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::config::restrict_to_owner;
use crate::storage::get_config_path;
use crate::sync_crypto::{
    derive_sync_key_material, SyncCryptoKdfParams, SyncKeyMaterial, KEY_LEN, SALT_LEN,
    SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
};


pub(crate) const SYNC_ENCRYPTION_LOG_PREFIX: &str = "[sync-encryption]";
pub(crate) const SYNC_ENCRYPTION_LOG_EVENT_STATE: &str = "state";
pub(crate) const SYNC_ENCRYPTION_LOG_EVENT_REMOTE_READ: &str = "remote-read";
pub(crate) const SYNC_ENCRYPTION_LOG_EVENT_TRANSITION: &str = "transition";
pub(crate) const SYNC_ENCRYPTION_LOG_EVENT_ERROR: &str = "error";
pub(crate) const SYNC_ENCRYPTION_LOG_ABSENT: &str = "-";

pub(crate) fn sync_encryption_diagnostic(event: &str, fields: &[(&str, String)]) -> String {
    let mut line = format!("{SYNC_ENCRYPTION_LOG_PREFIX} {event}");
    for (key, value) in fields {
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(if value.is_empty() { SYNC_ENCRYPTION_LOG_ABSENT } else { value });
    }
    line
}

pub(crate) fn sync_encryption_salt_prefix(salt: Option<&str>) -> String {
    match salt {
        Some(value)
            if !value.trim().is_empty()
                && value.trim().chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            value.trim().chars().take(8).collect::<String>().to_lowercase()
        }
        _ => SYNC_ENCRYPTION_LOG_ABSENT.to_string(),
    }
}

pub(crate) fn sync_encryption_salt_prefix_bytes(salt: &[u8]) -> String {
    sync_encryption_salt_prefix(Some(bytes_to_hex(salt).as_str()))
}

pub(crate) fn sync_encryption_kdf_label(params: Option<SyncCryptoKdfParams>) -> String {
    match params {
        Some(params) => format!("m={},t={},p={}", params.m_kib, params.t, params.p),
        None => SYNC_ENCRYPTION_LOG_ABSENT.to_string(),
    }
}

fn sync_encryption_digest32(value: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

pub(crate) fn sync_encryption_backend_label(scope: Option<&str>) -> String {
    let Some(scope) = scope.filter(|value| !value.trim().is_empty()) else {
        return SYNC_ENCRYPTION_LOG_ABSENT.to_string();
    };
    serde_json::from_str::<Vec<Option<String>>>(scope)
        .ok()
        .and_then(|parts| parts.into_iter().next().flatten())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "scope".to_string())
}

pub(crate) fn sync_encryption_scope_label(scope: Option<&str>) -> String {
    let Some(scope) = scope.filter(|value| !value.trim().is_empty()) else {
        return SYNC_ENCRYPTION_LOG_ABSENT.to_string();
    };
    format!("{}#{}", sync_encryption_backend_label(Some(scope)), sync_encryption_digest32(scope))
}

pub(crate) fn sync_encryption_artifact_label(name: &str) -> String {
    let trimmed = name.trim_end_matches(['/', '\\']);
    match trimmed.rsplit(['/', '\\']).next() {
        Some(leaf) if !leaf.is_empty() => leaf.to_string(),
        _ => SYNC_ENCRYPTION_LOG_ABSENT.to_string(),
    }
}

const SYNC_ENCRYPTION_STATE_FILE_NAME: &str = "sync-encryption-state.json";
pub(crate) const KEYRING_SYNC_ENCRYPTION_KEY: &str = "sync_encryption_key_v1";

pub(crate) const SYNC_ENCRYPTION_TERMINAL: &str = "SYNC_ENCRYPTION_TERMINAL";

pub(crate) const SYNC_ENCRYPTION_STATE_UNAVAILABLE: &str = "SYNC_ENCRYPTION_STATE_UNAVAILABLE";

pub(crate) const SYNC_ENCRYPTION_REMOTE_ENCRYPTED: &str = "SYNC_ENCRYPTION_REMOTE_ENCRYPTED";

pub(crate) const SYNC_ENCRYPTION_REMOTE_PLAINTEXT: &str = "SYNC_ENCRYPTION_REMOTE_PLAINTEXT";

pub(crate) fn terminal_error(reason: impl std::fmt::Display) -> String {
    format!("{SYNC_ENCRYPTION_TERMINAL}: {reason}")
}

fn state_unavailable_error(reason: impl std::fmt::Display) -> String {
    format!("{SYNC_ENCRYPTION_STATE_UNAVAILABLE}: {reason}")
}

pub(crate) fn is_terminal_error(error: &str) -> bool {
    error.starts_with(SYNC_ENCRYPTION_TERMINAL)
        || error.starts_with(SYNC_ENCRYPTION_STATE_UNAVAILABLE)
        || error.starts_with(SYNC_ENCRYPTION_REMOTE_ENCRYPTED)
        || error.starts_with(SYNC_ENCRYPTION_REMOTE_PLAINTEXT)
}

const KNOWN_ARTIFACT_SUFFIXES: [&str; 3] = [".bak", ".tmp", ".previous"];

fn split_trailing_suffix_chain(name: &str) -> (String, String) {
    let mut stem = name.to_string();
    let mut peeled: Vec<&'static str> = Vec::new();
    loop {
        let Some(matched) = KNOWN_ARTIFACT_SUFFIXES.iter().find(|suffix| stem.ends_with(*suffix)) else {
            break;
        };
        peeled.push(matched);
        stem.truncate(stem.len() - matched.len());
    }
    peeled.reverse();
    (stem, peeled.concat())
}

pub(crate) fn encrypted_artifact_name(plain_name: &str) -> String {
    let (stem, suffix_chain) = split_trailing_suffix_chain(plain_name);
    format!("{stem}.enc{suffix_chain}")
}

pub(crate) fn plaintext_artifact_name(enc_name: &str) -> String {
    let (stem, suffix_chain) = split_trailing_suffix_chain(enc_name);
    match stem.strip_suffix(".enc") {
        Some(plain_stem) => format!("{plain_stem}{suffix_chain}"),
        None => enc_name.to_string(),
    }
}

pub(crate) fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn hex_to_bytes(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len() / 2)
        .map(|index| u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok())
        .collect()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KdfParamsPayload {
    pub m_kib: u32,
    pub t: u32,
    pub p: u8,
}

impl From<SyncCryptoKdfParams> for KdfParamsPayload {
    fn from(value: SyncCryptoKdfParams) -> Self {
        Self { m_kib: value.m_kib, t: value.t, p: value.p }
    }
}

impl From<KdfParamsPayload> for SyncCryptoKdfParams {
    fn from(value: KdfParamsPayload) -> Self {
        Self { m_kib: value.m_kib, t: value.t, p: value.p }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncEncryptionLocalState {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kdf_params: Option<KdfParamsPayload>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovered_scope: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incomplete_transition: Option<String>,
}

pub(crate) const STATE_OFF: &str = "off";
pub(crate) const STATE_ENABLED: &str = "enabled";
pub(crate) const STATE_REMOTE_ENCRYPTED_NO_KEY: &str = "remote-encrypted-no-key";
pub(crate) const STATE_REMOTE_PLAINTEXT: &str = "remote-plaintext";
pub(crate) const TRANSITION_ENABLE: &str = "enable";
pub(crate) const TRANSITION_DISABLE: &str = "disable";
pub(crate) const TRANSITION_CHANGE_PASSPHRASE: &str = "change-passphrase";

fn valid_transition_kind(kind: &str) -> bool {
    matches!(
        kind,
        TRANSITION_ENABLE | TRANSITION_DISABLE | TRANSITION_CHANGE_PASSPHRASE | "upgrade"
    )
}

pub(crate) fn state_holds_key(state: &str) -> bool {
    state == STATE_ENABLED || state == STATE_REMOTE_PLAINTEXT
}

fn sync_encryption_state_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn lock_sync_encryption_state() -> MutexGuard<'static, ()> {
    sync_encryption_state_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn sync_encryption_state_path(app: &tauri::AppHandle) -> PathBuf {
    let config_path = get_config_path(app);
    let dir = config_path.parent().map(Path::to_path_buf).unwrap_or_default();
    dir.join(SYNC_ENCRYPTION_STATE_FILE_NAME)
}

fn read_state_file(path: &Path) -> Result<Option<SyncEncryptionLocalState>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(state_unavailable_error(format!(
            "failed to read local sync encryption state: {error}"
        ))),
    };
    let parsed: SyncEncryptionLocalState = serde_json::from_str(&raw)
        .map_err(|_| state_unavailable_error("local sync encryption state is invalid"))?;
    let valid_state = state_holds_key(&parsed.state)
        || parsed.state == STATE_REMOTE_ENCRYPTED_NO_KEY
        || (parsed.state == STATE_OFF && parsed.incomplete_transition.is_some());
    let valid_transition = parsed.incomplete_transition.as_deref().map_or(true, valid_transition_kind);
    if valid_state && valid_transition {
        Ok(Some(parsed))
    } else {
        Err(state_unavailable_error("local sync encryption state is invalid"))
    }
}

#[cfg(unix)]
fn sync_state_parent_directory(parent: &Path) -> Result<(), String> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Failed to flush sync encryption state directory: {error}"))
}

#[cfg(not(unix))]
fn sync_state_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn windows_state_path_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn windows_move_state_file_write_through(source: &Path, destination: &Path) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = windows_state_path_wide(source);
    let destination = windows_state_path_wide(destination);

    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn publish_state_temp_file(temp: &Path, destination: &Path) -> Result<(), String> {
    windows_move_state_file_write_through(temp, destination)
}

#[cfg(not(windows))]
fn publish_state_temp_file(temp: &Path, destination: &Path) -> Result<(), String> {
    std::fs::rename(temp, destination).map_err(|error| error.to_string())
}

fn publish_state_temp_file_durably_with<SyncTemp, Publish, SyncParent>(
    temp: &Path,
    destination: &Path,
    sync_temp: SyncTemp,
    publish: Publish,
    sync_parent: SyncParent,
) -> Result<(), String>
where
    SyncTemp: FnOnce() -> Result<(), String>,
    Publish: FnOnce(&Path, &Path) -> Result<(), String>,
    SyncParent: FnOnce(&Path) -> Result<(), String>,
{
    sync_temp()?;
    publish(temp, destination)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "Failed to resolve sync encryption state directory".to_string())?;
    sync_parent(parent)
}

#[cfg(windows)]
fn state_deletion_tombstone_path(path: &Path) -> Result<PathBuf, String> {
    use std::ffi::OsString;

    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve sync encryption state directory".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "Failed to resolve sync encryption state file name".to_string())?;
    let mut tombstone_name = OsString::from(".");
    tombstone_name.push(file_name);
    tombstone_name.push(".mindwtr-delete");
    Ok(parent.join(tombstone_name))
}

#[cfg(windows)]
fn securely_clear_state_deletion_tombstone(path: &Path) -> Result<(), String> {
    let empty = path.with_extension("delete-empty.tmp");
    let _ = std::fs::remove_file(&empty);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&empty)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    publish_state_temp_file(&empty, path)?;
    std::fs::remove_file(path).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn remove_state_file_for_platform(path: &Path) -> Result<bool, String> {
    let tombstone = state_deletion_tombstone_path(path)?;
    if !path.try_exists().map_err(|error| error.to_string())? {
        if tombstone.try_exists().map_err(|error| error.to_string())? {
            securely_clear_state_deletion_tombstone(&tombstone)?;
        }
        return Ok(false);
    }
    windows_move_state_file_write_through(path, &tombstone)?;
    securely_clear_state_deletion_tombstone(&tombstone)?;
    Ok(true)
}

#[cfg(not(windows))]
fn remove_state_file_for_platform(path: &Path) -> Result<bool, String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_state_file_durably_with<Remove, SyncParent>(
    path: &Path,
    remove: Remove,
    sync_parent: SyncParent,
) -> Result<(), String>
where
    Remove: FnOnce(&Path) -> Result<bool, String>,
    SyncParent: FnOnce(&Path) -> Result<(), String>,
{
    let _removed = remove(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve sync encryption state directory".to_string())?;
    sync_parent(parent)
}

fn remove_state_file_durably(path: &Path) -> Result<(), String> {
    remove_state_file_durably_with(
        path,
        remove_state_file_for_platform,
        sync_state_parent_directory,
    )
}

fn write_state_file(path: &Path, state: Option<&SyncEncryptionLocalState>) -> Result<(), String> {
    let Some(state) = state else {
        return remove_state_file_durably(path)
            .map_err(|error| format!("Failed to clear sync encryption state: {error}"));
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create config directory: {error}"))?;
    }
    let serialized = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Failed to encode sync encryption state: {error}"))?;

    let tmp = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|error| format!("Failed to create sync encryption state: {error}"))?;
    restrict_to_owner(&tmp, 0o600)?;
    file.write_all(serialized.as_bytes())
        .map_err(|error| format!("Failed to write sync encryption state: {error}"))?;
    publish_state_temp_file_durably_with(
        &tmp,
        path,
        move || {
            file.sync_all()
                .map_err(|error| format!("Failed to flush sync encryption state: {error}"))
        },
        publish_state_temp_file,
        sync_state_parent_directory,
    )
    .map_err(|error| format!("Failed to install sync encryption state: {error}"))
}

pub(crate) fn read_local_state(
    app: &tauri::AppHandle,
) -> Result<Option<SyncEncryptionLocalState>, String> {
    let _guard = lock_sync_encryption_state();
    read_state_file(&sync_encryption_state_path(app))
}

pub(crate) fn write_local_state(
    app: &tauri::AppHandle,
    state: Option<&SyncEncryptionLocalState>,
) -> Result<(), String> {
    let _guard = lock_sync_encryption_state();
    write_state_file(&sync_encryption_state_path(app), state)
}

pub(crate) fn begin_sync_encryption_transition(
    app: &tauri::AppHandle,
    kind: &str,
) -> Result<(), String> {
    if !valid_transition_kind(kind) {
        return Err(format!("Invalid sync encryption transition kind: {kind}"));
    }
    let _guard = lock_sync_encryption_state();
    let path = sync_encryption_state_path(app);
    let mut current = read_state_file(&path)?.unwrap_or_else(|| SyncEncryptionLocalState {
        state: STATE_OFF.to_string(),
        ..SyncEncryptionLocalState::default()
    });
    if let Some(existing) = current.incomplete_transition.as_deref() {
        if existing != kind {
            return Err(format!(
                "SYNC_ENCRYPTION_TRANSITION_INCOMPLETE: retry the {existing} sync encryption transition before starting {kind}"
            ));
        }
    }
    current.incomplete_transition = Some(kind.to_string());
    write_state_file(&path, Some(&current))
}

fn keyring_key_available(app: &tauri::AppHandle) -> Option<String> {
    crate::config::get_keyring_secret(app, KEYRING_SYNC_ENCRYPTION_KEY)
        .ok()
        .flatten()
}

fn store_cached_key(app: &tauri::AppHandle, key: &[u8; KEY_LEN]) -> Result<Option<String>, String> {
    let encoded = BASE64_STANDARD.encode(key);
    match crate::config::set_keyring_secret(app, KEYRING_SYNC_ENCRYPTION_KEY, Some(encoded.clone()))
    {
        Ok(()) => Ok(None),
        Err(error) => {
            log::warn!("Sync encryption key kept in the local config directory: {error}");
            Ok(Some(encoded))
        }
    }
}

fn clear_cached_key(app: &tauri::AppHandle) {
    if let Err(error) = crate::config::set_keyring_secret(app, KEYRING_SYNC_ENCRYPTION_KEY, None) {
        log::warn!("Failed to clear the cached sync encryption key: {error}");
    }
}

fn decode_key(encoded: &str) -> Option<[u8; KEY_LEN]> {
    let raw = BASE64_STANDARD.decode(encoded.trim()).ok()?;
    <[u8; KEY_LEN]>::try_from(raw.as_slice()).ok()
}

pub(crate) fn resolve_key_material(
    app: &tauri::AppHandle,
) -> Result<Option<SyncKeyMaterial>, String> {
    let Some(state) = read_local_state(app)? else {
        return Ok(None);
    };
    if !state_holds_key(&state.state) {
        return Ok(None);
    }
    let Some(salt_bytes) = state.salt.as_deref().and_then(hex_to_bytes) else {
        return Ok(None);
    };
    let Ok(salt) = <[u8; SALT_LEN]>::try_from(salt_bytes.as_slice()) else {
        return Ok(None);
    };
    let Some(params) = state.kdf_params.map(SyncCryptoKdfParams::from) else {
        return Ok(None);
    };
    let Some(encoded) = keyring_key_available(app).or_else(|| state.fallback_key.clone()) else {
        return Ok(None);
    };
    let Some(key) = decode_key(&encoded) else {
        return Ok(None);
    };
    Ok(Some(SyncKeyMaterial { key, salt, params }))
}

pub(crate) fn is_encryption_enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    Ok(read_local_state(app)?.is_some_and(|state| state_holds_key(&state.state)))
}

pub(crate) fn persist_enabled_material(
    app: &tauri::AppHandle,
    material: &SyncKeyMaterial,
) -> Result<(), String> {
    let fallback_key = store_cached_key(app, &material.key)?;
    write_local_state(
        app,
        Some(&SyncEncryptionLocalState {
            state: STATE_ENABLED.to_string(),
            salt: Some(bytes_to_hex(&material.salt)),
            kdf_params: Some(material.params.into()),

            discovered_scope: None,
            fallback_key,
            incomplete_transition: None,
        }),
    )
}

#[derive(Clone)]
enum KeyringMaterialSnapshot {
    Accessible(Option<String>),
    Unavailable,
}

#[derive(Clone)]
struct SyncEncryptionMaterialSnapshot {
    state: Option<SyncEncryptionLocalState>,
    keyring: KeyringMaterialSnapshot,
}

fn capture_sync_encryption_material_snapshot(
    app: &tauri::AppHandle,
) -> Result<SyncEncryptionMaterialSnapshot, String> {
    let state = read_local_state(app)?;
    let keyring = match crate::config::get_keyring_secret(app, KEYRING_SYNC_ENCRYPTION_KEY) {
        Ok(value) => KeyringMaterialSnapshot::Accessible(value),
        Err(_) => KeyringMaterialSnapshot::Unavailable,
    };
    Ok(SyncEncryptionMaterialSnapshot { state, keyring })
}

fn restore_sync_encryption_material_snapshot(
    app: &tauri::AppHandle,
    snapshot: &SyncEncryptionMaterialSnapshot,
) -> Result<(), String> {
    write_local_state(app, snapshot.state.as_ref())?;
    if let KeyringMaterialSnapshot::Accessible(value) = &snapshot.keyring {
        crate::config::set_keyring_secret(app, KEYRING_SYNC_ENCRYPTION_KEY, value.clone())
            .map_err(|error| format!("Failed to restore sync encryption key after lock loss: {error}"))?;
    }
    Ok(())
}

fn commit_encryption_material_with_fence<Validate, Commit, Rollback>(
    mut validate: Validate,
    commit: Commit,
    rollback: Rollback,
) -> Result<(), String>
where
    Validate: FnMut() -> Result<(), String>,
    Commit: FnOnce() -> Result<(), String>,
    Rollback: FnOnce() -> Result<(), String>,
{
    validate()?;
    let commit_result = commit();
    let final_validation = if commit_result.is_ok() {
        validate()
    } else {
        Ok(())
    };
    match (commit_result, final_validation) {
        (Ok(()), Ok(())) => Ok(()),
        (commit_result, final_validation) => {
            let primary = commit_result.err().or_else(|| final_validation.err())
                .expect("one material commit result must have failed");
            match rollback() {
                Ok(()) => Err(primary),
                Err(rollback_error) => Err(format!(
                    "{primary}; failed to roll back sync encryption material: {rollback_error}"
                )),
            }
        }
    }
}

pub(crate) fn persist_enabled_material_with_fence(
    app: &tauri::AppHandle,
    material: &SyncKeyMaterial,
    validate: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let snapshot = capture_sync_encryption_material_snapshot(app)?;
    commit_encryption_material_with_fence(
        validate,
        || persist_enabled_material(app, material),
        || restore_sync_encryption_material_snapshot(app, &snapshot),
    )
}

pub(crate) fn mark_remote_encrypted_no_key(
    app: &tauri::AppHandle,
    salt: &[u8],
    params: SyncCryptoKdfParams,
    scope: Option<&str>,
) -> Result<(), String> {
    if let Some(current) = read_local_state(app)? {
        if state_holds_key(&current.state)
            && current.salt.as_deref() == Some(bytes_to_hex(salt).as_str())
        {
            return Ok(());
        }
    }
    write_local_state(
        app,
        Some(&SyncEncryptionLocalState {
            state: STATE_REMOTE_ENCRYPTED_NO_KEY.to_string(),
            salt: Some(bytes_to_hex(salt)),
            kdf_params: Some(params.into()),
            discovered_scope: scope.map(str::to_string),
            fallback_key: None,
            incomplete_transition: None,
        }),
    )
}

pub(crate) fn mark_remote_plaintext(
    app: &tauri::AppHandle,
    scope: Option<&str>,
) -> Result<(), String> {
    let Some(current) = read_local_state(app)? else {
        return Ok(());
    };
    if current.state != STATE_ENABLED {
        return Ok(());
    }
    write_local_state(
        app,
        Some(&SyncEncryptionLocalState {
            state: STATE_REMOTE_PLAINTEXT.to_string(),
            discovered_scope: scope.map(str::to_string).or(current.discovered_scope.clone()),
            ..current
        }),
    )
}

#[allow(dead_code)]
pub(crate) fn sync_encryption_state_blocked(
    state: Option<&SyncEncryptionLocalState>,
    active_scope: Option<&str>,
) -> bool {
    let Some(state) = state else { return false };
    if state.incomplete_transition.is_some() {
        return true;
    }
    if state.state != STATE_REMOTE_ENCRYPTED_NO_KEY && state.state != STATE_REMOTE_PLAINTEXT {
        return false;
    }
    let Some(discovered) = state.discovered_scope.as_deref() else { return false };
    match active_scope {
        None => true,
        Some(active) => discovered == active,
    }
}

pub(crate) fn clear_stale_remote_encrypted_no_key(app: &tauri::AppHandle) -> Result<bool, String> {
    let Some(current) = read_local_state(app)? else {
        return Ok(false);
    };
    if current.state != STATE_REMOTE_ENCRYPTED_NO_KEY || current.incomplete_transition.is_some() {
        return Ok(false);
    }
    clear_encryption_state(app)?;
    Ok(true)
}

fn clear_encryption_state_with<PersistDisabled, ClearKey>(
    persist_disabled: PersistDisabled,
    clear_key: ClearKey,
) -> Result<(), String>
where
    PersistDisabled: FnOnce() -> Result<(), String>,
    ClearKey: FnOnce(),
{
    persist_disabled()?;
    clear_key();
    Ok(())
}

pub(crate) fn clear_encryption_state(app: &tauri::AppHandle) -> Result<(), String> {
    clear_encryption_state_with(|| write_local_state(app, None), || clear_cached_key(app))
}

pub(crate) fn clear_encryption_state_with_fence(
    app: &tauri::AppHandle,
    validate: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let snapshot = capture_sync_encryption_material_snapshot(app)?;
    commit_encryption_material_with_fence(
        validate,
        || clear_encryption_state(app),
        || restore_sync_encryption_material_snapshot(app, &snapshot),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncEncryptionStatus {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kdf_params: Option<KdfParamsPayload>,

    pub has_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incomplete_transition: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub salt_prefix: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovered_scope_label: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncEncryptionKeyMaterialPayload {
    pub key: String,
    pub salt: String,
    pub kdf_params: KdfParamsPayload,
}

impl From<&SyncKeyMaterial> for SyncEncryptionKeyMaterialPayload {
    fn from(material: &SyncKeyMaterial) -> Self {
        Self {
            key: BASE64_STANDARD.encode(material.key),
            salt: bytes_to_hex(&material.salt),
            kdf_params: material.params.into(),
        }
    }
}

pub(crate) fn parse_key_material_payload(
    key: &str,
    salt: &str,
    kdf_params: KdfParamsPayload,
) -> Result<SyncKeyMaterial, String> {
    let key = decode_key(key).ok_or_else(|| "Sync encryption key must be 32 base64 bytes".to_string())?;
    let salt_bytes = hex_to_bytes(salt).ok_or_else(|| "Sync encryption salt must be hex".to_string())?;
    let salt = <[u8; SALT_LEN]>::try_from(salt_bytes.as_slice())
        .map_err(|_| format!("Sync encryption salt must be {SALT_LEN} bytes"))?;
    Ok(SyncKeyMaterial { key, salt, params: kdf_params.into() })
}

#[tauri::command(async)]
pub(crate) fn get_sync_encryption_status(
    app: tauri::AppHandle,
) -> Result<SyncEncryptionStatus, String> {
    let Some(state) = read_local_state(&app)? else {
        return Ok(SyncEncryptionStatus {
            state: STATE_OFF.to_string(),
            kdf_params: None,
            has_key: false,
            incomplete_transition: None,
            salt_prefix: None,
            discovered_scope_label: None,
        });
    };
    let has_key = state_holds_key(&state.state)
        && keyring_key_available(&app)
            .or_else(|| state.fallback_key.clone())
            .and_then(|encoded| decode_key(&encoded))
            .is_some();
    Ok(sync_encryption_status_payload(state, has_key))
}

fn sync_encryption_status_payload(
    state: SyncEncryptionLocalState,
    has_key: bool,
) -> SyncEncryptionStatus {
    SyncEncryptionStatus {
        salt_prefix: state.salt.as_deref().map(|salt| sync_encryption_salt_prefix(Some(salt))),
        discovered_scope_label: state
            .discovered_scope
            .as_deref()
            .map(|scope| sync_encryption_scope_label(Some(scope))),
        state: state.state,
        kdf_params: state.kdf_params,
        has_key,
        incomplete_transition: state.incomplete_transition,
    }
}

#[tauri::command(async)]
pub(crate) fn get_sync_encryption_key_material(
    app: tauri::AppHandle,
) -> Result<Option<SyncEncryptionKeyMaterialPayload>, String> {
    Ok(resolve_key_material(&app)?.as_ref().map(SyncEncryptionKeyMaterialPayload::from))
}

#[tauri::command(async)]
pub(crate) fn set_sync_encryption_key_material(
    app: tauri::AppHandle,
    key: String,
    salt: String,
    kdf_params: KdfParamsPayload,
) -> Result<(), String> {
    let material = parse_key_material_payload(&key, &salt, kdf_params)?;
    persist_enabled_material(&app, &material)
}

#[tauri::command(async)]
pub(crate) fn clear_sync_encryption_key_material(app: tauri::AppHandle) -> Result<(), String> {
    clear_encryption_state(&app)
}

#[tauri::command(async)]
pub(crate) fn derive_sync_encryption_key(
    passphrase: String,
    salt: Option<String>,
    kdf_params: Option<KdfParamsPayload>,
) -> Result<SyncEncryptionKeyMaterialPayload, String> {
    let salt_bytes = match salt {
        Some(hex) => {
            let raw = hex_to_bytes(&hex).ok_or_else(|| "Sync encryption salt must be hex".to_string())?;
            <[u8; SALT_LEN]>::try_from(raw.as_slice())
                .map_err(|_| format!("Sync encryption salt must be {SALT_LEN} bytes"))?
        }
        None => crate::sync_crypto::random_salt(),
    };
    let params = kdf_params.map(SyncCryptoKdfParams::from).unwrap_or(SYNC_CRYPTO_DEFAULT_KDF_PARAMS);
    let material = derive_sync_key_material(&passphrase, salt_bytes, params)
        .map_err(|error| terminal_error(error))?;
    Ok(SyncEncryptionKeyMaterialPayload::from(&material))
}

#[tauri::command(async)]
pub(crate) fn mark_sync_encryption_remote_discovered(
    app: tauri::AppHandle,
    salt: String,
    kdf_params: KdfParamsPayload,
    location_scope: Option<String>,
) -> Result<(), String> {
    let salt_bytes = hex_to_bytes(&salt).ok_or_else(|| "Sync encryption salt must be hex".to_string())?;
    mark_remote_encrypted_no_key(&app, &salt_bytes, kdf_params.into(), location_scope.as_deref())
}

#[tauri::command(async)]
pub(crate) fn mark_sync_encryption_remote_plaintext(
    app: tauri::AppHandle,
    location_scope: Option<String>,
) -> Result<(), String> {
    mark_remote_plaintext(&app, location_scope.as_deref())
}

#[tauri::command(async)]
pub(crate) fn mark_sync_encryption_transition_incomplete(
    app: tauri::AppHandle,
    transition_kind: String,
) -> Result<(), String> {
    begin_sync_encryption_transition(&app, &transition_kind)
}

fn restore_verified_remote_encryption(
    current: &mut SyncEncryptionLocalState,
    salt: &str,
    params: KdfParamsPayload,
    scope: &str,
) -> bool {
    if current.state != STATE_REMOTE_PLAINTEXT
        || current.incomplete_transition.is_some()
        || scope.is_empty()
        || current.discovered_scope.as_deref() != Some(scope)
        || current.salt.as_deref() != Some(salt)
        || current.kdf_params != Some(params)
    {
        return false;
    }
    current.state = STATE_ENABLED.to_string();
    true
}

#[tauri::command(async)]
pub(crate) fn restore_sync_encryption_verified_remote(
    app: tauri::AppHandle,
    salt: String,
    kdf_params: KdfParamsPayload,
    location_scope: String,
) -> Result<bool, String> {
    let _guard = lock_sync_encryption_state();
    let path = sync_encryption_state_path(&app);
    let Some(mut current) = read_state_file(&path)? else { return Ok(false); };
    if !restore_verified_remote_encryption(&mut current, &salt, kdf_params, &location_scope) {
        return Ok(false);
    }
    write_state_file(&path, Some(&current))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_remote_recovery_requires_matching_location_generation_and_no_transition() {
        let params = KdfParamsPayload::from(SYNC_CRYPTO_DEFAULT_KDF_PARAMS);
        let stale = SyncEncryptionLocalState {
            state: STATE_REMOTE_PLAINTEXT.to_string(),
            salt: Some("0102".to_string()),
            kdf_params: Some(params),
            discovered_scope: Some("webdav-scope".to_string()),
            fallback_key: Some("preserved".to_string()),
            ..SyncEncryptionLocalState::default()
        };
        for (salt, scope) in [("other", "webdav-scope"), ("0102", "other"), ("0102", "")] {
            let mut state = stale.clone();
            assert!(!restore_verified_remote_encryption(&mut state, salt, params, scope));
            assert_eq!(state, stale);
        }
        let mut state = stale.clone();
        state.incomplete_transition = Some("disable".to_string());
        assert!(!restore_verified_remote_encryption(&mut state, "0102", params, "webdav-scope"));
        state = stale.clone();
        assert!(restore_verified_remote_encryption(&mut state, "0102", params, "webdav-scope"));
        assert_eq!(state, SyncEncryptionLocalState { state: STATE_ENABLED.to_string(), ..stale });
        assert!(!restore_verified_remote_encryption(&mut state, "0102", params, "webdav-scope"));
    }

    const ARTIFACT_NAMES_JSON: &str =
        include_str!("../../../../packages/core/src/__fixtures__/sync-crypto/artifact-names.json");

    #[derive(Deserialize)]
    struct ArtifactNameCase {
        plain: String,
        encrypted: String,
    }

    fn artifact_name_fixture() -> Vec<ArtifactNameCase> {
        serde_json::from_str(ARTIFACT_NAMES_JSON).expect("valid artifact-names.json")
    }

    #[test]
    fn encrypted_artifact_name_matches_the_shared_fixture() {
        let cases = artifact_name_fixture();
        assert!(!cases.is_empty());
        for case in &cases {
            assert_eq!(
                encrypted_artifact_name(&case.plain),
                case.encrypted,
                "encrypted_artifact_name({:?})",
                case.plain
            );
        }
    }

    #[test]
    fn plaintext_artifact_name_matches_the_shared_fixture() {
        for case in artifact_name_fixture() {
            assert_eq!(
                plaintext_artifact_name(&case.encrypted),
                case.plain,
                "plaintext_artifact_name({:?})",
                case.encrypted
            );
        }

        assert_eq!(plaintext_artifact_name("data.json"), "data.json");
    }

    #[test]
    fn hex_round_trips_and_rejects_odd_input() {
        assert_eq!(bytes_to_hex(&[0x00, 0x0f, 0xff]), "000fff");
        assert_eq!(hex_to_bytes("000fff"), Some(vec![0x00, 0x0f, 0xff]));
        assert_eq!(hex_to_bytes("abc"), None);
        assert_eq!(hex_to_bytes("zz"), None);
    }

    #[test]
    fn absent_state_file_is_the_off_default() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(read_state_file(&dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME))
            .expect("absent state")
            .is_none());
    }

    #[test]
    fn state_file_parses_without_the_discovered_scope_field() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        std::fs::write(
            &path,
            r#"{"state":"remote-encrypted-no-key","salt":"00112233445566778899aabbccddeeff"}"#,
        )
        .expect("seed legacy state");
        let parsed = read_state_file(&path).expect("read state").expect("state present");
        assert_eq!(parsed.state, STATE_REMOTE_ENCRYPTED_NO_KEY);
        assert_eq!(parsed.discovered_scope, None);

        assert!(!sync_encryption_state_blocked(
            Some(&parsed),
            Some(r#"["file","/sync"]"#)
        ));
    }

    #[test]
    fn blocked_only_for_the_location_the_discovery_was_made_on() {
        let scoped = |scope: Option<&str>, state: &str| SyncEncryptionLocalState {
            state: state.to_string(),
            salt: Some("00".repeat(16)),
            kdf_params: Some(SYNC_CRYPTO_DEFAULT_KDF_PARAMS.into()),
            discovered_scope: scope.map(str::to_string),
            fallback_key: None,
            incomplete_transition: None,
        };
        let here = r#"["file","/sync"]"#;
        let elsewhere = r#"["cloud","dropbox"]"#;

        let no_key_here = scoped(Some(here), STATE_REMOTE_ENCRYPTED_NO_KEY);
        assert!(sync_encryption_state_blocked(Some(&no_key_here), Some(here)));
        assert!(!sync_encryption_state_blocked(Some(&no_key_here), Some(elsewhere)));

        assert!(sync_encryption_state_blocked(Some(&no_key_here), None));

        assert!(sync_encryption_state_blocked(
            Some(&scoped(Some(here), STATE_REMOTE_PLAINTEXT)),
            Some(here),
        ));
        assert!(!sync_encryption_state_blocked(Some(&scoped(Some(here), STATE_ENABLED)), Some(here)));
        assert!(!sync_encryption_state_blocked(None, Some(here)));

        let mut interrupted = scoped(None, STATE_OFF);
        interrupted.incomplete_transition = Some(TRANSITION_ENABLE.to_string());
        assert!(sync_encryption_state_blocked(Some(&interrupted), Some(elsewhere)));
    }

    #[test]
    fn state_file_round_trips_and_clears() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        let state = SyncEncryptionLocalState {
            state: STATE_ENABLED.to_string(),
            salt: Some("00112233445566778899aabbccddeeff".to_string()),
            kdf_params: Some(SYNC_CRYPTO_DEFAULT_KDF_PARAMS.into()),
            discovered_scope: None,
            fallback_key: None,
            incomplete_transition: None,
        };
        write_state_file(&path, Some(&state)).expect("write state");
        assert_eq!(read_state_file(&path).expect("read state"), Some(state));
        write_state_file(&path, None).expect("clear state");
        assert!(read_state_file(&path).expect("read cleared state").is_none());

        write_state_file(&path, None).expect("clear again");
    }

    #[test]
    fn state_publish_acknowledges_parent_metadata_after_install() {
        let dir = tempfile::tempdir().expect("temp dir");
        let temp = dir.path().join("state.tmp");
        let destination = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        let events = std::cell::RefCell::new(Vec::new());

        publish_state_temp_file_durably_with(
            &temp,
            &destination,
            || {
                events.borrow_mut().push("sync-temp");
                Ok(())
            },
            |_, _| {
                events.borrow_mut().push("publish");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("sync-parent");
                Ok(())
            },
        )
        .expect("durable publish");

        assert_eq!(
            &*events.borrow(),
            &["sync-temp", "publish", "sync-parent"]
        );
    }

    #[test]
    fn failed_state_file_flush_prevents_publish() {
        let dir = tempfile::tempdir().expect("temp dir");
        let temp = dir.path().join("state.tmp");
        let destination = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        let events = std::cell::RefCell::new(Vec::new());

        let error = publish_state_temp_file_durably_with(
            &temp,
            &destination,
            || {
                events.borrow_mut().push("sync-temp");
                Err("file flush failed".to_string())
            },
            |_, _| {
                events.borrow_mut().push("publish");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("sync-parent");
                Ok(())
            },
        )
        .expect_err("an unflushed state file must not be published");

        assert_eq!(error, "file flush failed");
        assert_eq!(&*events.borrow(), &["sync-temp"]);
    }

    #[test]
    fn failed_state_removal_metadata_flush_blocks_key_clear() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        let events = std::cell::RefCell::new(Vec::new());

        let error = clear_encryption_state_with(
            || {
                remove_state_file_durably_with(
                    &path,
                    |_| {
                        events.borrow_mut().push("remove");
                        Ok(true)
                    },
                    |_| {
                        events.borrow_mut().push("sync-parent");
                        Err("directory flush failed".to_string())
                    },
                )
            },
            || events.borrow_mut().push("clear-key"),
        )
        .expect_err("metadata flush failure must preserve retry key");

        assert_eq!(error, "directory flush failed");
        assert_eq!(&*events.borrow(), &["remove", "sync-parent"]);
    }

    #[test]
    fn lock_loss_after_material_commit_runs_compensation_before_returning() {
        let events = std::cell::RefCell::new(Vec::new());
        let validations = std::cell::Cell::new(0usize);

        let error = commit_encryption_material_with_fence(
            || {
                validations.set(validations.get() + 1);
                events.borrow_mut().push("validate");
                if validations.get() == 2 {
                    Err("lock identity changed".to_string())
                } else {
                    Ok(())
                }
            },
            || {
                events.borrow_mut().push("commit");
                Ok(())
            },
            || {
                events.borrow_mut().push("rollback-state-then-key");
                Ok(())
            },
        )
        .expect_err("post-commit lock loss must fail and compensate");

        assert_eq!(error, "lock identity changed");
        assert_eq!(
            &*events.borrow(),
            &["validate", "commit", "validate", "rollback-state-then-key"]
        );
    }

    #[test]
    fn failed_material_commit_is_compensated_and_reports_rollback_failure() {
        let error = commit_encryption_material_with_fence(
            || Ok(()),
            || Err("state persistence failed".to_string()),
            || Err("key restoration failed".to_string()),
        )
        .expect_err("a partial commit with failed compensation must be explicit");

        assert!(error.contains("state persistence failed"));
        assert!(error.contains("key restoration failed"));
    }

    #[test]
    fn already_absent_state_still_requires_durable_parent_sync_before_key_clear() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        let events = std::cell::RefCell::new(Vec::new());

        let error = clear_encryption_state_with(
            || {
                remove_state_file_durably_with(
                    &path,
                    |_| {
                        events.borrow_mut().push("confirm-absent");
                        Ok(false)
                    },
                    |_| {
                        events.borrow_mut().push("sync-parent");
                        Err("directory flush failed".to_string())
                    },
                )
            },
            || events.borrow_mut().push("clear-key"),
        )
        .expect_err("an unflushed prior deletion must preserve the retry key");

        assert_eq!(error, "directory flush failed");
        assert_eq!(&*events.borrow(), &["confirm-absent", "sync-parent"]);
    }

    #[test]
    fn disabled_state_write_failure_preserves_cached_key_for_retry() {
        let key_cleared = std::cell::Cell::new(false);

        let error = clear_encryption_state_with(
            || Err("state storage unavailable".to_string()),
            || key_cleared.set(true),
        )
        .expect_err("failed disabled-state persistence must abort key clearing");

        assert_eq!(error, "state storage unavailable");
        assert!(!key_cleared.get(), "retry material must remain cached");
    }

    #[test]
    fn a_corrupt_or_explicit_off_state_file_fails_closed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        std::fs::write(&path, b"not json").expect("write");
        assert!(read_state_file(&path)
            .expect_err("corrupt state must fail")
            .contains(SYNC_ENCRYPTION_STATE_UNAVAILABLE));
        std::fs::write(&path, br#"{"state":"off"}"#).expect("write");
        assert!(read_state_file(&path)
            .expect_err("explicit off must fail")
            .contains(SYNC_ENCRYPTION_STATE_UNAVAILABLE));
    }

    #[test]
    fn an_off_state_is_valid_only_with_a_matching_transition_journal() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        let state = SyncEncryptionLocalState {
            state: STATE_OFF.to_string(),
            incomplete_transition: Some(TRANSITION_ENABLE.to_string()),
            ..SyncEncryptionLocalState::default()
        };
        write_state_file(&path, Some(&state)).expect("write journal");
        assert_eq!(read_state_file(&path).expect("read journal"), Some(state));
    }

    #[test]
    fn an_unreadable_state_path_fails_closed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        std::fs::create_dir(&path).expect("state path directory");

        assert!(read_state_file(&path)
            .expect_err("unreadable state must fail")
            .contains(SYNC_ENCRYPTION_STATE_UNAVAILABLE));
    }

    #[test]
    fn key_material_payload_round_trips() {
        let material = SyncKeyMaterial {
            key: [7u8; KEY_LEN],
            salt: [3u8; SALT_LEN],
            params: SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
        };
        let payload = SyncEncryptionKeyMaterialPayload::from(&material);
        let parsed = parse_key_material_payload(&payload.key, &payload.salt, payload.kdf_params)
            .expect("parse payload");
        assert_eq!(parsed.key, material.key);
        assert_eq!(parsed.salt, material.salt);
        assert_eq!(parsed.params, material.params);
    }

    #[test]
    fn a_short_key_is_rejected_rather_than_padded() {
        let short = BASE64_STANDARD.encode([1u8; 16]);
        let err = parse_key_material_payload(&short, &"00".repeat(SALT_LEN), SYNC_CRYPTO_DEFAULT_KDF_PARAMS.into())
            .expect_err("short key must be rejected");
        assert!(err.contains("32 base64 bytes"), "unexpected error: {err}");
    }

    #[test]
    fn terminal_errors_are_recognizable_by_prefix() {
        assert!(is_terminal_error(&terminal_error("wrong passphrase or corrupted data")));
        assert!(is_terminal_error(SYNC_ENCRYPTION_REMOTE_ENCRYPTED));
        assert!(!is_terminal_error("Invalid sync payload shape: expected an object"));
    }

    #[test]
    fn diagnostic_lines_are_one_grep_able_key_value_line() {
        let line = sync_encryption_diagnostic(
            SYNC_ENCRYPTION_LOG_EVENT_STATE,
            &[
                ("backend", "file".to_string()),
                ("state", STATE_ENABLED.to_string()),
                ("hasMaterial", "true".to_string()),
                ("kdf", String::new()),
            ],
        );
        assert_eq!(
            line,
            "[sync-encryption] state backend=file state=enabled hasMaterial=true kdf=-"
        );
    }

    #[test]
    fn a_salt_is_logged_as_eight_hex_characters_at_most() {
        assert_eq!(sync_encryption_salt_prefix(Some(&"07".repeat(16))), "07070707");
        assert_eq!(sync_encryption_salt_prefix_bytes(&[0xab; SALT_LEN]), "abababab");
        assert_eq!(sync_encryption_salt_prefix(None), "-");
        assert_eq!(sync_encryption_salt_prefix(Some("  ")), "-");

        assert!(!sync_encryption_salt_prefix_bytes(&[0xab; SALT_LEN]).contains(&"ab".repeat(16)));
    }

    #[test]
    fn a_location_scope_is_logged_as_backend_plus_digest_never_the_path() {
        assert_eq!(
            sync_encryption_scope_label(Some(r#"["file","/home/u/Sync/data.json"]"#)),
            "file#eb9492f4"
        );
        assert_eq!(
            sync_encryption_scope_label(Some(r#"["cloud","dropbox"]"#)),
            "cloud#0879d27a"
        );

        let webdav = r#"["webdav","https://dav.example.com/remote.php/dav/","alice"]"#;
        let label = sync_encryption_scope_label(Some(webdav));
        assert!(label.starts_with("webdav#"));
        assert!(!label.contains("alice"));
        assert!(!label.contains("dav.example.com"));
        assert_eq!(sync_encryption_scope_label(None), "-");
    }

    #[test]
    fn an_artifact_is_logged_by_its_leaf_name_only() {
        assert_eq!(
            sync_encryption_artifact_label("/home/u/Sync/data.json.enc"),
            "data.json.enc"
        );
        assert_eq!(sync_encryption_artifact_label("data.json"), "data.json");
        assert_eq!(sync_encryption_artifact_label(""), "-");
    }

    #[test]
    fn no_diagnostic_line_can_carry_a_passphrase_or_a_key() {
        let passphrase = "correct horse battery staple";
        let key = [0x5a_u8; KEY_LEN];
        let salt = [0xab_u8; SALT_LEN];
        let scope = r#"["file","/home/u/Sync/data.json"]"#;

        let lines = [
            sync_encryption_diagnostic(
                SYNC_ENCRYPTION_LOG_EVENT_STATE,
                &[
                    ("backend", "file".to_string()),
                    ("state", STATE_REMOTE_ENCRYPTED_NO_KEY.to_string()),
                    ("hasMaterial", "false".to_string()),
                    ("saltPrefix", sync_encryption_salt_prefix_bytes(&salt)),
                    (
                        "kdf",
                        sync_encryption_kdf_label(Some(SYNC_CRYPTO_DEFAULT_KDF_PARAMS)),
                    ),
                    ("activeScope", sync_encryption_scope_label(Some(scope))),
                    ("decision", "blocked-no-key".to_string()),
                ],
            ),
            sync_encryption_diagnostic(
                SYNC_ENCRYPTION_LOG_EVENT_REMOTE_READ,
                &[
                    (
                        "artifact",
                        sync_encryption_artifact_label(&encrypted_artifact_name("data.json")),
                    ),
                    ("headerSaltPrefix", sync_encryption_salt_prefix_bytes(&salt)),
                    ("decision", "no-key".to_string()),
                ],
            ),
            sync_encryption_diagnostic(
                SYNC_ENCRYPTION_LOG_EVENT_TRANSITION,
                &[
                    ("kind", TRANSITION_ENABLE.to_string()),
                    ("backend", "file".to_string()),
                    ("phase", "end".to_string()),
                    ("outcome", "ok".to_string()),
                ],
            ),
        ];

        for line in &lines {
            assert!(!line.contains(passphrase), "passphrase leaked into: {line}");
            assert!(!line.contains(&bytes_to_hex(&key)), "key leaked into: {line}");
            assert!(!line.contains(&BASE64_STANDARD.encode(key)), "key leaked into: {line}");

            assert!(!line.contains(&bytes_to_hex(&salt)), "full salt leaked into: {line}");

            assert!(!line.contains("/home/u/Sync"), "sync path leaked into: {line}");
        }
        assert!(lines[0].starts_with("[sync-encryption] state"));
        assert!(lines[1].contains("artifact=data.json.enc"));
        assert!(lines[2].contains("outcome=ok"));
    }

    #[test]
    fn the_status_payload_carries_a_truncated_salt_and_the_discovery_scope() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        write_state_file(
            &path,
            Some(&SyncEncryptionLocalState {
                state: STATE_REMOTE_ENCRYPTED_NO_KEY.to_string(),
                salt: Some("07".repeat(16)),
                kdf_params: Some(SYNC_CRYPTO_DEFAULT_KDF_PARAMS.into()),
                discovered_scope: Some(r#"["cloud","dropbox"]"#.to_string()),
                fallback_key: None,
                incomplete_transition: None,
            }),
        )
        .unwrap();
        let state = read_state_file(&path).unwrap().unwrap();
        assert_eq!(
            sync_encryption_salt_prefix(state.salt.as_deref()),
            "07070707"
        );
        assert_eq!(
            sync_encryption_scope_label(state.discovered_scope.as_deref()),
            "cloud#0879d27a"
        );
    }

    #[test]
    fn the_sync_encryption_status_payload_never_carries_a_raw_scope_or_a_whole_salt() {
        let salt = "07".repeat(16);
        let payload = sync_encryption_status_payload(
            SyncEncryptionLocalState {
                state: STATE_REMOTE_ENCRYPTED_NO_KEY.to_string(),
                salt: Some(salt.clone()),
                kdf_params: Some(SYNC_CRYPTO_DEFAULT_KDF_PARAMS.into()),
                discovered_scope: Some(
                    r#"["webdav","https://dav.example.com/remote.php/dav/","alice"]"#.to_string(),
                ),
                fallback_key: None,
                incomplete_transition: None,
            },
            false,
        );
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains(r#""discoveredScopeLabel":"webdav#"#), "{json}");
        assert!(!json.contains("dav.example.com"), "{json}");
        assert!(!json.contains("alice"), "{json}");
        assert!(!json.contains(salt.as_str()), "{json}");
        assert!(json.contains(r#""saltPrefix":"07070707""#), "{json}");
    }

    #[test]
    fn a_sync_encryption_salt_prefix_rejects_non_hex_input() {
        assert_eq!(sync_encryption_salt_prefix(Some("deadBEEF00")), "deadbeef");
        assert_eq!(sync_encryption_salt_prefix(Some("/home/u/Sync")), "-");
        assert_eq!(sync_encryption_salt_prefix(Some("  ")), "-");
        assert_eq!(sync_encryption_salt_prefix(None), "-");
    }

    #[test]
    fn a_sync_encryption_backend_label_names_the_scope_backend() {
        let webdav = r#"["webdav","https://dav.example.com/remote.php/dav/","alice"]"#;
        assert_eq!(sync_encryption_backend_label(Some(webdav)), "webdav");
        assert!(sync_encryption_scope_label(Some(webdav)).starts_with("webdav#"));
        assert_eq!(sync_encryption_backend_label(Some(r#"["file","/home/u/Sync"]"#)), "file");
        assert_eq!(sync_encryption_backend_label(Some("not json")), "scope");
        assert_eq!(sync_encryption_backend_label(None), "-");
    }
}
