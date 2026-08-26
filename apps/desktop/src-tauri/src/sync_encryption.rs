//! Device-local sync-encryption state and key cache (#1056, phase 2 of 3).
//!
//! This module owns everything about "is this device's sync folder encrypted, and what key
//! opens it" on desktop. The MWENC1 container itself lives in `sync_crypto.rs`; the storage
//! seams that use it live in `sync.rs` (file backend + WebDAV) and in the desktop TS layer
//! (Dropbox, attachments). Naming and semantics mirror `packages/core/src/sync-encryption.ts`
//! -- that file is the specification; this is the Rust half the file backend needs because
//! Rust owns that backend's IO.
//!
//! Two things are persisted, deliberately in two different places:
//!   * the state + salt + KDF params, in a device-local sidecar JSON next to config.toml.
//!     None of it is secret (the salt and params are in every artifact header anyway) and
//!     `get_sync_encryption_status` must be answerable without unlocking the OS keyring.
//!   * the derived 32-byte key, base64, in the OS keyring. The passphrase itself is NEVER
//!     persisted anywhere.
//!
//! Nothing here is ever synced: no encryption state, salt, params or key enters the synced
//! document, the content signature, or config.toml.

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

const SYNC_ENCRYPTION_STATE_FILE_NAME: &str = "sync-encryption-state.json";
const KEYRING_SYNC_ENCRYPTION_KEY: &str = "sync_encryption_key_v1";

/// Prefix on every error string a decrypt failure produces at a storage seam. The whole point
/// of the class is that it must never be mistaken for "invalid JSON, try the next candidate /
/// repair it": callers upstream (the read-recovery chain here, `classifySyncEncryptionFailure`
/// in the desktop TS) branch on this prefix to stop the run and ask for the passphrase again.
pub(crate) const SYNC_ENCRYPTION_TERMINAL: &str = "SYNC_ENCRYPTION_TERMINAL";

/// Returned when a device with no key finds MWENC1 bytes where it expected the sync document.
/// The command layer persists `remote-encrypted-no-key` before surfacing this to TS.
pub(crate) const SYNC_ENCRYPTION_REMOTE_ENCRYPTED: &str = "SYNC_ENCRYPTION_REMOTE_ENCRYPTED";

/// The inverse: returned when a device that HOLDS a key finds no encrypted artifact and a
/// plaintext document in its place -- a peer disabled encryption at the sync location. The
/// command layer persists `remote-plaintext` before surfacing it. Never auto-downgrades:
/// following the remote to plaintext would let anyone with write access to the storage strip
/// encryption from every device.
pub(crate) const SYNC_ENCRYPTION_REMOTE_PLAINTEXT: &str = "SYNC_ENCRYPTION_REMOTE_PLAINTEXT";

pub(crate) fn terminal_error(reason: impl std::fmt::Display) -> String {
    format!("{SYNC_ENCRYPTION_TERMINAL}: {reason}")
}

pub(crate) fn is_terminal_error(error: &str) -> bool {
    error.starts_with(SYNC_ENCRYPTION_TERMINAL)
        || error.starts_with(SYNC_ENCRYPTION_REMOTE_ENCRYPTED)
        || error.starts_with(SYNC_ENCRYPTION_REMOTE_PLAINTEXT)
}

/// `data.json` -> `data.json.enc`; `data.json.bak` -> `data.json.enc.bak`; `data.json.bak.previous`
/// -> `data.json.enc.bak.previous`. The `.enc` marker goes immediately after the data-file stem
/// and the FULL trailing suffix chain is carried verbatim after it -- never
/// `data.json.bak.enc.previous`, a name nothing reads. Mirrors `syncEncryptedArtifactName` in
/// packages/core/src/sync-encryption.ts.
const KNOWN_ARTIFACT_SUFFIXES: [&str; 3] = [".bak", ".tmp", ".previous"];

/// Peels every trailing known suffix off `name` (repeatedly -- `.bak.previous` is two), returning
/// the bare stem plus the peeled suffixes re-joined in their ORIGINAL left-to-right order
/// (peeling happens right-to-left, so the collected list is reversed before joining).
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
    // `usize::is_multiple_of` is 1.87; this crate builds on an older MSRV.
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

/// Device-local, never-synced. Mirrors core's `SyncEncryptionLocalState`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncEncryptionLocalState {
    /// "off" | "enabled" | "remote-encrypted-no-key" | "remote-plaintext"
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kdf_params: Option<KdfParamsPayload>,
    /// Only ever populated when the OS keyring is unavailable (portable mode, or a keyring
    /// backend that refuses to store). See `store_cached_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_key: Option<String>,
}

pub(crate) const STATE_OFF: &str = "off";
pub(crate) const STATE_ENABLED: &str = "enabled";
pub(crate) const STATE_REMOTE_ENCRYPTED_NO_KEY: &str = "remote-encrypted-no-key";
pub(crate) const STATE_REMOTE_PLAINTEXT: &str = "remote-plaintext";

/// The states in which this device owns a usable key. `remote-plaintext` is one of them on
/// purpose: dropping to "encryption off" there is exactly the silent downgrade the state
/// exists to prevent, and the user's only sanctioned way out -- running the disable
/// transition -- needs the key. Mirrors core's `SYNC_ENCRYPTION_KEYED_STATES`.
pub(crate) fn state_holds_key(state: &str) -> bool {
    state == STATE_ENABLED || state == STATE_REMOTE_PLAINTEXT
}

// Serializes the sidecar's read-modify-write spans. Deliberately NOT
// lock_config_read_modify_write: this file is not config.toml, nothing here goes through
// read_config/write_config_files, and taking the config lock for it would add a second
// reason to hold the app's outermost lock (and a nesting hazard) for no benefit. Poison-
// recovering for the same reason the config locks are.
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
        Err(error) => return Err(terminal_error(format!(
            "failed to read local sync encryption state: {error}"
        ))),
    };
    let parsed: SyncEncryptionLocalState = serde_json::from_str(&raw)
        .map_err(|_| terminal_error("local sync encryption state is invalid"))?;
    if state_holds_key(&parsed.state) || parsed.state == STATE_REMOTE_ENCRYPTED_NO_KEY {
        Ok(Some(parsed))
    } else {
        Err(terminal_error("local sync encryption state is invalid"))
    }
}

fn write_state_file(path: &Path, state: Option<&SyncEncryptionLocalState>) -> Result<(), String> {
    let Some(state) = state else {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Failed to clear sync encryption state: {error}")),
        }
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create config directory: {error}"))?;
    }
    let serialized = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Failed to encode sync encryption state: {error}"))?;
    // Create-new + rename, the same discipline every other sync write uses: never reopen an
    // existing file for truncating overwrite (#1001).
    let tmp = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    std::fs::write(&tmp, serialized.as_bytes())
        .map_err(|error| format!("Failed to write sync encryption state: {error}"))?;
    restrict_to_owner(&tmp, 0o600)?;
    if cfg!(windows) {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path)
        .map_err(|error| format!("Failed to install sync encryption state: {error}"))
}

/// Reads the persisted state. `None` means the implicit, never-written 'off' default -- the
/// state every existing install is in, which is why 'off' is represented by the ABSENCE of the
/// file rather than a file saying "off" (an update must change nothing on disk by itself).
pub(crate) fn read_local_state(app: &tauri::AppHandle) -> Result<Option<SyncEncryptionLocalState>, String> {
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

fn keyring_key_available(app: &tauri::AppHandle) -> Option<String> {
    crate::config::get_keyring_secret(app, KEYRING_SYNC_ENCRYPTION_KEY)
        .ok()
        .flatten()
}

/// ponytail: when the OS keyring is unavailable (portable mode, or a headless/locked backend),
/// the derived key falls back into the owner-only sidecar in plaintext -- exactly what the
/// WebDAV password and cloud token already do via secrets.toml, and consistent with the local
/// SQLite database being unencrypted. The feature's threat model is the sync PROVIDER, not the
/// local disk. Upgrade path if that ever changes: an OS-independent local KEK.
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

/// The full material every write seam needs (the key alone cannot build a header). An absent
/// sidecar is the only implicit-off state; unreadable or invalid sidecars are terminal.
pub(crate) fn resolve_key_material(app: &tauri::AppHandle) -> Result<Option<SyncKeyMaterial>, String> {
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

/// True when this device believes the remote is encrypted, whether or not it has the key.
/// Used by the seams to decide between the `.enc` names and the plaintext ones.
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
            fallback_key,
        }),
    )
}

/// Mirrors core's `markRemoteEncryptionDiscovered`: never downgrades a keyed device whose
/// salt matches the discovery, and persists immediately so the state survives a restart
/// without needing the user to acknowledge anything first. A keyed device under a DIFFERENT
/// salt is provably holding a foreign key (a passphrase set before the first sync while a
/// peer encrypted the remote, or a peer's rotation) and does downgrade -- the no-key state is
/// the only one that surfaces the unlock prompt able to re-derive from the remote's own salt.
pub(crate) fn mark_remote_encrypted_no_key(
    app: &tauri::AppHandle,
    salt: &[u8],
    params: SyncCryptoKdfParams,
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
            fallback_key: None,
        }),
    )
}

/// Mirrors core's `markRemotePlaintextDiscovered`: only an `enabled` device can reach this
/// state, and its salt/params/fallback key are carried over unchanged so the key stays
/// resolvable -- running the disable transition is the only sanctioned way out and it needs
/// one.
pub(crate) fn mark_remote_plaintext(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(current) = read_local_state(app)? else {
        return Ok(());
    };
    if current.state != STATE_ENABLED {
        return Ok(());
    }
    write_local_state(
        app,
        Some(&SyncEncryptionLocalState { state: STATE_REMOTE_PLAINTEXT.to_string(), ..current }),
    )
}

pub(crate) fn clear_encryption_state(app: &tauri::AppHandle) -> Result<(), String> {
    clear_cached_key(app);
    write_local_state(app, None)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncEncryptionStatus {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kdf_params: Option<KdfParamsPayload>,
    /// Whether the derived key is actually available on this device right now. Phase 3 needs
    /// this to tell "enabled and working" from "enabled but the keyring entry is gone".
    pub has_key: bool,
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

// ---------------------------------------------------------------------------
// Commands
//
// All `(async)`: Argon2id at the default cost burns ~19 MiB and tens of milliseconds, and the
// keyring call is IPC to another process -- either one on the webview's IPC thread freezes the
// window (#1001). None of these read or write config.toml, so none takes
// lock_config_read_modify_write; the sidecar has its own lock above.
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub(crate) fn get_sync_encryption_status(
    app: tauri::AppHandle,
) -> Result<SyncEncryptionStatus, String> {
    let Some(state) = read_local_state(&app)? else {
        return Ok(SyncEncryptionStatus {
            state: STATE_OFF.to_string(),
            kdf_params: None,
            has_key: false,
        });
    };
    let has_key = state_holds_key(&state.state)
        && keyring_key_available(&app)
            .or_else(|| state.fallback_key.clone())
            .and_then(|encoded| decode_key(&encoded))
            .is_some();
    Ok(SyncEncryptionStatus { state: state.state, kdf_params: state.kdf_params, has_key })
}

/// The key cache's `getKey`, and the material the TS-driven seams (Dropbox, and WebDAV under a
/// config override) need to build headers. Rust's keyring is the single source of truth even
/// for the backends TS drives -- desktop TS never keeps a cache of its own.
#[tauri::command(async)]
pub(crate) fn get_sync_encryption_key_material(
    app: tauri::AppHandle,
) -> Result<Option<SyncEncryptionKeyMaterialPayload>, String> {
    Ok(resolve_key_material(&app)?.as_ref().map(SyncEncryptionKeyMaterialPayload::from))
}

/// The key cache's `setKey`, called by the TS transition orchestration once a WebDAV/Dropbox
/// transition has completed. Persisting here (and not before) is what keeps the
/// "never persist a backend's enabled flag before its first successful round-trip" rule.
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

/// The key cache's `clearKey`. Also drops the persisted state back to the implicit 'off'.
#[tauri::command(async)]
pub(crate) fn clear_sync_encryption_key_material(app: tauri::AppHandle) -> Result<(), String> {
    clear_encryption_state(&app)
}

/// Argon2id derivation for the TS seams. Returns raw key bytes (base64); the passphrase is
/// never persisted and never leaves this call.
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

/// Called by the TS seams (Dropbox / WebDAV-under-override) the moment they find ciphertext
/// they have no key for.
#[tauri::command(async)]
pub(crate) fn mark_sync_encryption_remote_discovered(
    app: tauri::AppHandle,
    salt: String,
    kdf_params: KdfParamsPayload,
) -> Result<(), String> {
    let salt_bytes = hex_to_bytes(&salt).ok_or_else(|| "Sync encryption salt must be hex".to_string())?;
    mark_remote_encrypted_no_key(&app, &salt_bytes, kdf_params.into())
}

/// Called by the TS seams (Dropbox / WebDAV-under-override) the moment they find the sync
/// location back in plaintext while this device still holds a key.
#[tauri::command(async)]
pub(crate) fn mark_sync_encryption_remote_plaintext(app: tauri::AppHandle) -> Result<(), String> {
    mark_remote_plaintext(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared with packages/core/src/sync-encryption.test.ts — both languages' name mapping
    // must agree on every case, including compound suffix chains (S1: `.bak.previous` was
    // previously mis-mapped by matching only the LAST suffix instead of the full chain).
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
        // Defensive: a name with no marker comes back untouched.
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
    fn state_file_round_trips_and_clears() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        let state = SyncEncryptionLocalState {
            state: STATE_ENABLED.to_string(),
            salt: Some("00112233445566778899aabbccddeeff".to_string()),
            kdf_params: Some(SYNC_CRYPTO_DEFAULT_KDF_PARAMS.into()),
            fallback_key: None,
        };
        write_state_file(&path, Some(&state)).expect("write state");
        assert_eq!(read_state_file(&path).expect("read state"), Some(state));
        write_state_file(&path, None).expect("clear state");
        assert!(read_state_file(&path).expect("read cleared state").is_none());
        // Clearing an already-absent file is not an error (idempotent disable).
        write_state_file(&path, None).expect("clear again");
    }

    #[test]
    fn a_corrupt_or_explicit_off_state_file_fails_closed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        std::fs::write(&path, b"not json").expect("write");
        assert!(read_state_file(&path)
            .expect_err("corrupt state must fail")
            .contains(SYNC_ENCRYPTION_TERMINAL));
        std::fs::write(&path, br#"{"state":"off"}"#).expect("write");
        assert!(read_state_file(&path)
            .expect_err("explicit off must fail")
            .contains(SYNC_ENCRYPTION_TERMINAL));
    }

    #[test]
    fn an_unreadable_state_path_fails_closed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(SYNC_ENCRYPTION_STATE_FILE_NAME);
        std::fs::create_dir(&path).expect("state path directory");

        assert!(read_state_file(&path)
            .expect_err("unreadable state must fail")
            .contains(SYNC_ENCRYPTION_TERMINAL));
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
}
