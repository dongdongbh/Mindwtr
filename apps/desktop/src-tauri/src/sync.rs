use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use fs2::FileExt;
use rand::RngCore;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::error::Error as StdError;
#[cfg(unix)]
use std::ffi::{CStr, CString};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_fs::FsExt;

#[cfg(test)]
use crate::attachment_installer::move_no_replace;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt as _;
#[cfg(target_os = "windows")]
use std::os::windows::fs::MetadataExt as _;
#[cfg(target_os = "windows")]
use std::os::windows::io::AsRawHandle as _;

use crate::config::{
    get_keyring_secret, lock_config_read_modify_write, read_bound_credential, read_config,
    read_dropbox_credential_state, set_keyring_secret, update_dropbox_credential_state,
    write_config_files, CredentialService,
};
use crate::file_sync_attachment_publication::{
    self, PublicationAttempt, PublicationReservation,
};
use crate::storage::{
    get_config_path, get_secrets_path, read_json_with_retries_decoded,
    read_json_with_retries_validated,
};
use crate::sync_crypto::{
    decrypt_sync_artifact, derive_sync_key_material, encrypt_sync_artifact, inspect_sync_artifact,
    random_salt, ParsedHeaderFields, SyncArtifactInspection, SyncCryptoError, SyncCryptoKdfParams,
    SyncKeyMaterial, KEY_LEN, SALT_LEN, SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
};
use crate::sync_encryption::{
    begin_sync_encryption_transition, bytes_to_hex, clear_encryption_state_with_fence,
    encrypted_artifact_name, hex_to_bytes,
    is_encryption_enabled, is_terminal_error, mark_remote_encrypted_no_key,
    mark_remote_plaintext, persist_enabled_material_with_fence,
    plaintext_artifact_name, resolve_key_material, terminal_error,
    TRANSITION_CHANGE_PASSPHRASE, TRANSITION_DISABLE, TRANSITION_ENABLE,
    SYNC_ENCRYPTION_REMOTE_ENCRYPTED, SYNC_ENCRYPTION_REMOTE_PLAINTEXT,
};
#[cfg(target_os = "macos")]
use crate::{
    mindwtr_macos_create_security_bookmark, mindwtr_macos_free_bookmark_string,
    mindwtr_macos_resolve_security_bookmark,
};
use crate::{
    AppConfigToml, DropboxCredentialStateFile, DropboxResolvedCredentialHandle, DropboxTokenBundle,
    DropboxTokenResponse,
    APP_NAME, DATA_FILE_NAME, DROPBOX_AUTH_ENDPOINT, DROPBOX_DEFAULT_TOKEN_LIFETIME_SECS,
    DROPBOX_OAUTH_TIMEOUT_SECS, DROPBOX_REDIRECT_HOST, DROPBOX_REDIRECT_PATH,
    DROPBOX_REDIRECT_PORT, DROPBOX_REVOKE_ENDPOINT, DROPBOX_SCOPES, DROPBOX_TOKEN_ENDPOINT,
    DROPBOX_TOKEN_REFRESH_SKEW_MS, KEYRING_DROPBOX_TOKENS,
};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteJsonWriteResult {
    fingerprint: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
    content_length: Option<String>,
    server_merged_remote_data: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebdavSyncReadResult {
    data: Value,
    exists: bool,
    strong_etag: Option<String>,
}

const NATIVE_HTTP_TIMEOUT_SECS: u64 = 30;
const WEBDAV_REMOTE_WRITE_CONFLICT: &str = "WEBDAV_REMOTE_WRITE_CONFLICT";
const WEBDAV_VERSION_MARKER: &str = "mindwtr-webdav-version";
const DROPBOX_STAGED_CREDENTIAL_TTL_MS: i64 = 30 * 60 * 1000;
const DROPBOX_MAX_STAGED_CREDENTIALS: usize = 4;
const DROPBOX_MAX_RESOLVED_CREDENTIAL_HANDLES: usize = 16;
const DROPBOX_RESOLVED_CREDENTIAL_HANDLE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const DROPBOX_PROMOTION_JOURNAL_VERSION: u8 = 1;
const KEYRING_DROPBOX_PROMOTION_JOURNAL: &str = "dropbox_promotion_journal_v1";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DropboxStartupRecoveryOutcome {
    Ready,
    SyncDisabled { warning: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "tokens", rename_all = "snake_case")]
enum DropboxPreviousCredentials {
    Empty,
    Bundle(DropboxTokenBundle),
    UnknownKeyring,
}

impl DropboxPreviousCredentials {
    fn from_tokens(tokens: Option<DropboxTokenBundle>) -> Self {
        match tokens {
            Some(tokens) => Self::Bundle(tokens),
            None => Self::Empty,
        }
    }

    fn as_tokens(&self) -> Option<&DropboxTokenBundle> {
        match self {
            Self::Empty => None,
            Self::Bundle(tokens) => Some(tokens),
            Self::UnknownKeyring => None,
        }
    }

    fn cloned_tokens(&self) -> Option<DropboxTokenBundle> {
        self.as_tokens().cloned()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DropboxCredentialPromotionJournal {
    version: u8,
    candidate_client_id: String,
    candidate_fingerprint: String,
    previous: DropboxPreviousCredentials,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum DropboxPromotionJournalFallbackRecord {
    PendingKeyring {
        version: u8,
        journal_fingerprint: String,
    },
    Pending {
        journal: DropboxCredentialPromotionJournal,
    },
    Cleared {
        version: u8,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DropboxRecoveryCommitState {
    raw_backend: String,
    backend_marker: String,
    cloud_provider: String,
    cloud_provider_authority: String,
}

fn inferred_dropbox_recovery_commit_state(raw_backend: String) -> DropboxRecoveryCommitState {
    let cloud_provider = if raw_backend.trim() == "cloud" {
        "dropbox"
    } else {
        "selfhosted"
    };
    DropboxRecoveryCommitState {
        backend_marker: raw_backend.clone(),
        raw_backend,
        cloud_provider: cloud_provider.to_string(),
        cloud_provider_authority: "native".to_string(),
    }
}

fn dropbox_recovery_state_is_durably_off(state: &DropboxRecoveryCommitState) -> bool {
    state.raw_backend.trim() == "off" && state.backend_marker.trim() == "off"
}

fn require_durably_disabled_dropbox_backend(
    state: DropboxRecoveryCommitState,
) -> Result<String, String> {
    if dropbox_recovery_state_is_durably_off(&state) {
        Ok("off".to_string())
    } else {
        Err("Dropbox credentials can only be changed while sync is durably disabled".to_string())
    }
}

fn dropbox_recovery_state_is_committed_dropbox(state: &DropboxRecoveryCommitState) -> bool {
    state.raw_backend.trim() == "cloud"
        && state.backend_marker.trim() == "cloud"
        && state.cloud_provider.trim() == "dropbox"
        && state.cloud_provider_authority.trim() == "native"
}

fn dropbox_token_bundle_fingerprint(tokens: &DropboxTokenBundle) -> Result<String, String> {
    let serialized = serde_json::to_vec(tokens)
        .map_err(|_| "Failed to fingerprint Dropbox credentials".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(serialized)))
}

fn dropbox_credential_handle_fingerprint(credential_handle: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(credential_handle.as_bytes()))
}

fn prune_resolved_dropbox_credential_handles(
    handles: &mut Vec<DropboxResolvedCredentialHandle>,
    now: i64,
) {
    handles.retain(|handle| {
        now.saturating_sub(handle.resolved_at_ms) <= DROPBOX_RESOLVED_CREDENTIAL_HANDLE_TTL_MS
    });
    if handles.len() > DROPBOX_MAX_RESOLVED_CREDENTIAL_HANDLES {
        handles.sort_by_key(|handle| handle.resolved_at_ms);
        let excess = handles.len() - DROPBOX_MAX_RESOLVED_CREDENTIAL_HANDLES;
        handles.drain(..excess);
    }
}

fn record_resolved_dropbox_credential_handle_with(
    handles: &mut Vec<DropboxResolvedCredentialHandle>,
    credential_handle: &str,
    candidate: &DropboxTokenBundle,
    now: i64,
) -> Result<(), String> {
    prune_resolved_dropbox_credential_handles(handles, now);
    let handle_fingerprint = dropbox_credential_handle_fingerprint(credential_handle);
    let candidate_fingerprint = dropbox_token_bundle_fingerprint(candidate)?;
    handles.retain(|handle| handle.handle_fingerprint != handle_fingerprint);
    handles.push(DropboxResolvedCredentialHandle {
        handle_fingerprint,
        client_id: candidate.client_id.clone(),
        candidate_fingerprint,
        resolved_at_ms: now,
    });
    prune_resolved_dropbox_credential_handles(handles, now);
    Ok(())
}

fn resolved_dropbox_credential_handle_matches_with(
    handles: &[DropboxResolvedCredentialHandle],
    credential_handle: &str,
    active: &DropboxTokenBundle,
    now: i64,
) -> Result<bool, String> {
    let handle_fingerprint = dropbox_credential_handle_fingerprint(credential_handle);
    let candidate_fingerprint = dropbox_token_bundle_fingerprint(active)?;
    Ok(handles.iter().any(|handle| {
        now.saturating_sub(handle.resolved_at_ms) <= DROPBOX_RESOLVED_CREDENTIAL_HANDLE_TTL_MS
            && handle.handle_fingerprint == handle_fingerprint
            && handle.client_id == active.client_id
            && handle.candidate_fingerprint == candidate_fingerprint
    }))
}

fn record_resolved_dropbox_credential_handle(
    app: &tauri::AppHandle,
    credential_handle: &str,
    candidate: &DropboxTokenBundle,
) -> Result<(), String> {
    update_dropbox_credential_state(app, |state| {
        record_resolved_dropbox_credential_handle_with(
            &mut state.resolved_credential_handles,
            credential_handle,
            candidate,
            now_unix_ms(),
        )
    })?;
    let state = read_dropbox_credential_state(app)?;
    if !resolved_dropbox_credential_handle_matches_with(
        &state.resolved_credential_handles,
        credential_handle,
        candidate,
        now_unix_ms(),
    )? {
        return Err("Dropbox resolved handle failed durable read-back verification".to_string());
    }
    Ok(())
}

fn build_dropbox_promotion_journal(
    previous: Option<DropboxTokenBundle>,
    candidate: &DropboxTokenBundle,
) -> Result<DropboxCredentialPromotionJournal, String> {
    build_dropbox_promotion_journal_with_previous(
        DropboxPreviousCredentials::from_tokens(previous),
        candidate,
    )
}

fn build_dropbox_promotion_journal_with_previous(
    previous: DropboxPreviousCredentials,
    candidate: &DropboxTokenBundle,
) -> Result<DropboxCredentialPromotionJournal, String> {
    Ok(DropboxCredentialPromotionJournal {
        version: DROPBOX_PROMOTION_JOURNAL_VERSION,
        candidate_client_id: candidate.client_id.clone(),
        candidate_fingerprint: dropbox_token_bundle_fingerprint(candidate)?,
        previous,
    })
}

fn journal_matches_candidate(
    journal: &DropboxCredentialPromotionJournal,
    active: &DropboxTokenBundle,
) -> Result<bool, String> {
    Ok(journal.version == DROPBOX_PROMOTION_JOURNAL_VERSION
        && active.client_id == journal.candidate_client_id
        && dropbox_token_bundle_fingerprint(active)? == journal.candidate_fingerprint)
}

fn resolve_unknown_dropbox_previous_credentials_with<ReadKeyring>(
    journal: &DropboxCredentialPromotionJournal,
    mut read_keyring: ReadKeyring,
) -> Result<DropboxPreviousCredentials, String>
where
    ReadKeyring: FnMut() -> Result<Option<String>, String>,
{
    if !matches!(journal.previous, DropboxPreviousCredentials::UnknownKeyring) {
        return Ok(journal.previous.clone());
    }
    let raw = read_keyring().map_err(|_| {
        "Previous Dropbox keyring state is still unavailable during recovery".to_string()
    })?;
    let Some(raw) = raw else {
        return Ok(DropboxPreviousCredentials::Empty);
    };
    let tokens = parse_dropbox_token_bundle(&raw)?;
    // Unknown-keyring promotion is fallback-only and therefore cannot have
    // written this entry. Exact-candidate bytes may already have existed and
    // are preserved just like any different valid prior bundle.
    Ok(DropboxPreviousCredentials::Bundle(tokens))
}

fn resolve_unknown_dropbox_previous_credentials(
    app: &tauri::AppHandle,
    journal: &DropboxCredentialPromotionJournal,
) -> Result<DropboxPreviousCredentials, String> {
    resolve_unknown_dropbox_previous_credentials_with(journal, || {
        get_keyring_secret(app, KEYRING_DROPBOX_TOKENS)
    })
}

fn recover_known_dropbox_promotion_journal_with<
    ReadCommitState,
    ReadActive,
    ResolveUnknownPrevious,
    WriteActive,
    ReadJournal,
    ClearJournal,
>(
    journal: &DropboxCredentialPromotionJournal,
    read_commit_state: &mut ReadCommitState,
    read_active: &mut ReadActive,
    resolve_unknown_previous: &mut ResolveUnknownPrevious,
    write_active: &mut WriteActive,
    read_journal: &mut ReadJournal,
    clear_journal: &mut ClearJournal,
) -> Result<(), String>
where
    ReadCommitState: FnMut() -> Result<DropboxRecoveryCommitState, String>,
    ReadActive: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
    ResolveUnknownPrevious:
        FnMut(&DropboxCredentialPromotionJournal) -> Result<DropboxPreviousCredentials, String>,
    WriteActive: FnMut(Option<&DropboxTokenBundle>) -> Result<(), String>,
    ReadJournal: FnMut() -> Result<Option<DropboxCredentialPromotionJournal>, String>,
    ClearJournal: FnMut() -> Result<(), String>,
{
    if journal.version != DROPBOX_PROMOTION_JOURNAL_VERSION {
        return Err("Dropbox credential promotion journal has an unsupported version".to_string());
    }

    let commit = read_commit_state()?;
    let committed_dropbox = dropbox_recovery_state_is_committed_dropbox(&commit);
    if committed_dropbox {
        let active = read_active()?.ok_or_else(|| {
            "Committed Dropbox credential promotion has no active credentials".to_string()
        })?;
        if !journal_matches_candidate(journal, &active)? {
            return Err(
                "Committed Dropbox credentials do not match the promotion journal".to_string(),
            );
        }
    } else {
        if commit.raw_backend.trim() != commit.backend_marker.trim()
            || commit.raw_backend.trim() == "cloud"
            || commit.backend_marker.trim() == "cloud"
        {
            return Err("Dropbox credential promotion commit markers are inconsistent".to_string());
        }
        let previous_authority =
            if matches!(journal.previous, DropboxPreviousCredentials::UnknownKeyring) {
                resolve_unknown_previous(journal)?
            } else {
                journal.previous.clone()
            };
        let previous = previous_authority.cloned_tokens();
        write_active(previous.as_ref())?;
        if read_active()? != previous {
            return Err(
                "Previous Dropbox credentials failed crash-recovery read-back verification"
                    .to_string(),
            );
        }
    }

    clear_journal()?;
    if read_journal()?.is_some() {
        return Err(
            "Dropbox credential promotion journal failed deletion verification".to_string(),
        );
    }
    Ok(())
}

fn recover_dropbox_promotion_journal_with<
    ReadBackend,
    ReadActive,
    WriteActive,
    ReadJournal,
    ClearJournal,
>(
    mut read_backend: ReadBackend,
    mut read_active: ReadActive,
    mut write_active: WriteActive,
    mut read_journal: ReadJournal,
    mut clear_journal: ClearJournal,
) -> Result<(), String>
where
    ReadBackend: FnMut() -> Result<String, String>,
    ReadActive: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
    WriteActive: FnMut(Option<&DropboxTokenBundle>) -> Result<(), String>,
    ReadJournal: FnMut() -> Result<Option<DropboxCredentialPromotionJournal>, String>,
    ClearJournal: FnMut() -> Result<(), String>,
{
    let Some(journal) = read_journal()? else {
        return Ok(());
    };
    let mut read_commit_state = || read_backend().map(inferred_dropbox_recovery_commit_state);
    let mut resolve_unknown_previous = |_journal: &DropboxCredentialPromotionJournal| {
        Err("Unknown keyring recovery requires a keyring authority reader".to_string())
    };
    recover_known_dropbox_promotion_journal_with(
        &journal,
        &mut read_commit_state,
        &mut read_active,
        &mut resolve_unknown_previous,
        &mut write_active,
        &mut read_journal,
        &mut clear_journal,
    )
}

fn recover_dropbox_credentials_fail_closed_with_commit_state<
    ReadCommitState,
    WriteBackend,
    ReadActive,
    ResolveUnknownPrevious,
    WriteActive,
    ReadJournal,
    ClearJournal,
>(
    mut read_commit_state: ReadCommitState,
    mut write_backend: WriteBackend,
    mut read_active: ReadActive,
    mut resolve_unknown_previous: ResolveUnknownPrevious,
    mut write_active: WriteActive,
    mut read_journal: ReadJournal,
    mut clear_journal: ClearJournal,
) -> Result<(), String>
where
    ReadCommitState: FnMut() -> Result<DropboxRecoveryCommitState, String>,
    WriteBackend: FnMut(&str) -> Result<(), String>,
    ReadActive: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
    ResolveUnknownPrevious:
        FnMut(&DropboxCredentialPromotionJournal) -> Result<DropboxPreviousCredentials, String>,
    WriteActive: FnMut(Option<&DropboxTokenBundle>) -> Result<(), String>,
    ReadJournal: FnMut() -> Result<Option<DropboxCredentialPromotionJournal>, String>,
    ClearJournal: FnMut() -> Result<(), String>,
{
    let journal = match read_journal() {
        Ok(None) => return Ok(()),
        Ok(Some(journal)) => journal,
        Err(initial_error) => {
            // Once the Dropbox backend has reached its exact durable commit
            // point, cleanup uncertainty is post-commit. Never turn it into a
            // rollback by disabling the backend first: doing so would erase the
            // only commit evidence and a later recovery would restore the old
            // credentials. Leave both the candidate and backend intact so the
            // caller can refuse its pending disable and retry cleanup safely.
            let commit_state = read_commit_state().map_err(|_| {
                "Dropbox credential recovery could not verify the durable sync commit state; recovery remains pending and no state was changed"
                    .to_string()
            })?;
            if dropbox_recovery_state_is_committed_dropbox(&commit_state) {
                return Err(format!(
                    "Dropbox credential recovery cleanup failed after commit; the active Dropbox commit was left intact: {initial_error}"
                ));
            }
            write_backend("off").map_err(|disable_error| {
                format!(
                    "Dropbox credential recovery failed and sync could not be disabled: {initial_error}; {disable_error}"
                )
            })?;
            let disabled = read_commit_state().map_err(|disable_error| {
                format!(
                    "Dropbox credential recovery failed and disabled state could not be verified: {initial_error}; {disable_error}"
                )
            })?;
            if !dropbox_recovery_state_is_durably_off(&disabled) {
                return Err(format!(
                    "Dropbox credential recovery failed and sync was not durably disabled: {initial_error}"
                ));
            }
            return Err(format!(
                "Dropbox credential recovery failed; sync was disabled but recovery remains pending: {initial_error}"
            ));
        }
    };

    let initial_commit_state = read_commit_state().map_err(|_| {
        "Dropbox credential recovery could not verify the durable sync commit state; recovery remains pending and no state was changed"
            .to_string()
    })?;
    let committed_dropbox = dropbox_recovery_state_is_committed_dropbox(&initial_commit_state);
    let mut read_initial_commit_state = || Ok(initial_commit_state.clone());
    let initial = recover_known_dropbox_promotion_journal_with(
        &journal,
        &mut read_initial_commit_state,
        &mut read_active,
        &mut resolve_unknown_previous,
        &mut write_active,
        &mut read_journal,
        &mut clear_journal,
    );
    let Err(initial_error) = initial else {
        return Ok(());
    };

    if committed_dropbox {
        return Err(format!(
            "Dropbox credential recovery cleanup failed after commit; the active Dropbox commit was left intact: {initial_error}"
        ));
    }

    write_backend("off").map_err(|disable_error| {
        format!(
            "Dropbox credential recovery failed and sync could not be disabled: {initial_error}; {disable_error}"
        )
    })?;
    let disabled = read_commit_state().map_err(|disable_error| {
        format!(
            "Dropbox credential recovery failed and disabled state could not be verified: {initial_error}; {disable_error}"
        )
    })?;
    if !dropbox_recovery_state_is_durably_off(&disabled) {
        return Err(format!(
            "Dropbox credential recovery failed and sync was not durably disabled: {initial_error}"
        ));
    }

    if journal.version != DROPBOX_PROMOTION_JOURNAL_VERSION {
        return Err(format!(
            "Dropbox credential recovery failed; sync was disabled but recovery remains pending: {initial_error}"
        ));
    }

    // Keep using the journal value read before the first attempt. A keyring
    // deletion may succeed while its verification read fails; re-reading at
    // this point could therefore return `None` and lose the only retained copy
    // of the previous credential bundle.
    let previous_authority = if matches!(
        journal.previous,
        DropboxPreviousCredentials::UnknownKeyring
    ) {
        resolve_unknown_previous(&journal).map_err(|recovery_error| {
            format!(
                "Dropbox credential recovery failed; sync was disabled but recovery remains pending: {initial_error}; {recovery_error}"
            )
        })?
    } else {
        journal.previous.clone()
    };
    let previous = previous_authority.cloned_tokens();
    write_active(previous.as_ref()).map_err(|recovery_error| {
        format!(
            "Dropbox credential recovery failed; sync was disabled but recovery remains pending: {initial_error}; {recovery_error}"
        )
    })?;
    if read_active().map_err(|recovery_error| {
        format!(
            "Dropbox credential recovery failed; sync was disabled but recovery remains pending: {initial_error}; {recovery_error}"
        )
    })? != previous
    {
        return Err(format!(
            "Dropbox credential recovery failed; sync was disabled but recovery remains pending: {initial_error}; previous credentials failed read-back verification"
        ));
    }

    clear_journal().map_err(|recovery_error| {
        format!(
            "Dropbox credential recovery failed; sync was disabled but recovery remains pending: {initial_error}; {recovery_error}"
        )
    })?;
    if read_journal().map_err(|recovery_error| {
        format!(
            "Dropbox credential recovery failed; sync was disabled but recovery remains pending: {initial_error}; {recovery_error}"
        )
    })?.is_some()
    {
        return Err(format!(
            "Dropbox credential recovery failed; sync was disabled but recovery remains pending: {initial_error}; journal deletion failed read-back verification"
        ));
    }

    Err(format!(
        "Dropbox credential recovery failed; sync was disabled and previous credentials were restored: {initial_error}"
    ))
}

fn recover_dropbox_credentials_fail_closed_with<
    ReadBackend,
    WriteBackend,
    ReadActive,
    WriteActive,
    ReadJournal,
    ClearJournal,
>(
    mut read_backend: ReadBackend,
    write_backend: WriteBackend,
    read_active: ReadActive,
    write_active: WriteActive,
    read_journal: ReadJournal,
    clear_journal: ClearJournal,
) -> Result<(), String>
where
    ReadBackend: FnMut() -> Result<String, String>,
    WriteBackend: FnMut(&str) -> Result<(), String>,
    ReadActive: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
    WriteActive: FnMut(Option<&DropboxTokenBundle>) -> Result<(), String>,
    ReadJournal: FnMut() -> Result<Option<DropboxCredentialPromotionJournal>, String>,
    ClearJournal: FnMut() -> Result<(), String>,
{
    recover_dropbox_credentials_fail_closed_with_commit_state(
        || read_backend().map(inferred_dropbox_recovery_commit_state),
        write_backend,
        read_active,
        |_journal| Err("Unknown keyring recovery requires a keyring authority reader".to_string()),
        write_active,
        read_journal,
        clear_journal,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DropboxStagedCredentialPhase {
    Candidate,
    Promoted {
        previous: DropboxPreviousCredentials,
    },
}

#[derive(Debug, Clone)]
struct DropboxStagedCredential {
    tokens: DropboxTokenBundle,
    phase: DropboxStagedCredentialPhase,
    created_at: i64,
}

#[derive(Default)]
pub(crate) struct DropboxStagedCredentialState {
    inner: Arc<Mutex<HashMap<String, DropboxStagedCredential>>>,
}

fn prune_expired_staged_dropbox_credentials(
    entries: &mut HashMap<String, DropboxStagedCredential>,
    now: i64,
) {
    entries.retain(|_, entry| {
        !matches!(entry.phase, DropboxStagedCredentialPhase::Candidate)
            || now.saturating_sub(entry.created_at) <= DROPBOX_STAGED_CREDENTIAL_TTL_MS
    });
}

fn insert_staged_dropbox_credentials(
    entries: &mut HashMap<String, DropboxStagedCredential>,
    credential_handle: String,
    tokens: DropboxTokenBundle,
    now: i64,
) -> Result<(), String> {
    let handle = credential_handle.trim();
    if handle.is_empty() {
        return Err("Dropbox credential handle is empty".to_string());
    }
    prune_expired_staged_dropbox_credentials(entries, now);
    if entries.contains_key(handle) {
        return Err("Dropbox credential handle already exists".to_string());
    }
    while entries.len() >= DROPBOX_MAX_STAGED_CREDENTIALS {
        let oldest_candidate = entries
            .iter()
            .filter(|(_, entry)| matches!(entry.phase, DropboxStagedCredentialPhase::Candidate))
            .min_by_key(|(_, entry)| entry.created_at)
            .map(|(handle, _)| handle.clone());
        let Some(oldest_candidate) = oldest_candidate else {
            return Err(
                "Too many Dropbox credential transactions are awaiting rollback".to_string(),
            );
        };
        entries.remove(&oldest_candidate);
    }
    entries.insert(
        handle.to_string(),
        DropboxStagedCredential {
            tokens,
            phase: DropboxStagedCredentialPhase::Candidate,
            created_at: now,
        },
    );
    Ok(())
}

fn stage_dropbox_credentials(
    entries: &mut HashMap<String, DropboxStagedCredential>,
    tokens: DropboxTokenBundle,
    now: i64,
) -> Result<String, String> {
    for _ in 0..8 {
        let credential_handle = generate_random_urlsafe(32);
        if entries.contains_key(&credential_handle) {
            continue;
        }
        insert_staged_dropbox_credentials(entries, credential_handle.clone(), tokens, now)?;
        return Ok(credential_handle);
    }
    Err("Failed to allocate an opaque Dropbox credential handle".to_string())
}

fn staged_dropbox_entry_mut<'a>(
    entries: &'a mut HashMap<String, DropboxStagedCredential>,
    credential_handle: &str,
    client_id: &str,
    now: i64,
) -> Result<&'a mut DropboxStagedCredential, String> {
    prune_expired_staged_dropbox_credentials(entries, now);
    let entry = entries
        .get_mut(credential_handle)
        .ok_or_else(|| "Dropbox credential handle is invalid or expired".to_string())?;
    if entry.tokens.client_id != client_id {
        return Err("Dropbox credential handle belongs to a different app key".to_string());
    }
    Ok(entry)
}

fn resolve_staged_dropbox_access_token_with<F>(
    entries: &mut HashMap<String, DropboxStagedCredential>,
    credential_handle: &str,
    client_id: &str,
    force_refresh: bool,
    now: i64,
    mut refresh: F,
) -> Result<String, String>
where
    F: FnMut(&str, &str) -> Result<(String, i64), String>,
{
    let entry = staged_dropbox_entry_mut(entries, credential_handle, client_id, now)?;
    if !force_refresh && now < entry.tokens.expires_at - DROPBOX_TOKEN_REFRESH_SKEW_MS {
        return Ok(entry.tokens.access_token.clone());
    }
    let (access_token, expires_at) = refresh(client_id, &entry.tokens.refresh_token)?;
    if access_token.trim().is_empty() {
        return Err("Dropbox token refresh returned an invalid payload".to_string());
    }
    entry.tokens.access_token = access_token;
    entry.tokens.expires_at = expires_at;
    Ok(entry.tokens.access_token.clone())
}

fn format_dropbox_restore_error(primary: &str, restore: Result<(), String>) -> String {
    match restore {
        Ok(()) => primary.to_string(),
        Err(error) => {
            format!("{primary}. Previous Dropbox credentials could not be restored: {error}")
        }
    }
}

fn restore_active_dropbox_credentials_with<ReadActive, WriteActive>(
    previous: &Option<DropboxTokenBundle>,
    read_active: &mut ReadActive,
    write_active: &mut WriteActive,
) -> Result<(), String>
where
    ReadActive: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
    WriteActive: FnMut(Option<&DropboxTokenBundle>) -> Result<(), String>,
{
    write_active(previous.as_ref())?;
    if read_active()? != *previous {
        return Err(
            "Previous Dropbox credentials failed durable read-back verification".to_string(),
        );
    }
    Ok(())
}

fn promote_staged_dropbox_credentials_with<ReadActive, WriteActive>(
    entries: &mut HashMap<String, DropboxStagedCredential>,
    credential_handle: &str,
    client_id: &str,
    now: i64,
    mut read_active: ReadActive,
    mut write_active: WriteActive,
) -> Result<(), String>
where
    ReadActive: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
    WriteActive: FnMut(Option<&DropboxTokenBundle>) -> Result<(), String>,
{
    let entry = staged_dropbox_entry_mut(entries, credential_handle, client_id, now)?;
    let candidate = entry.tokens.clone();
    if matches!(entry.phase, DropboxStagedCredentialPhase::Promoted { .. }) {
        let active = read_active()?;
        return if active.as_ref() == Some(&candidate) {
            Ok(())
        } else {
            Err("Promoted Dropbox credentials failed durable read-back verification".to_string())
        };
    }

    let previous = read_active()?;
    if let Err(error) = write_active(Some(&candidate)) {
        let restore =
            restore_active_dropbox_credentials_with(&previous, &mut read_active, &mut write_active);
        if restore.is_err() {
            entry.phase = DropboxStagedCredentialPhase::Promoted {
                previous: DropboxPreviousCredentials::from_tokens(previous.clone()),
            };
        }
        return Err(format_dropbox_restore_error(
            &format!("Failed to promote Dropbox credentials: {error}"),
            restore,
        ));
    }

    match read_active() {
        Ok(active) if active.as_ref() == Some(&candidate) => {
            entry.phase = DropboxStagedCredentialPhase::Promoted {
                previous: DropboxPreviousCredentials::from_tokens(previous),
            };
            Ok(())
        }
        Ok(_) => {
            let restore = restore_active_dropbox_credentials_with(
                &previous,
                &mut read_active,
                &mut write_active,
            );
            if restore.is_err() {
                entry.phase = DropboxStagedCredentialPhase::Promoted {
                    previous: DropboxPreviousCredentials::from_tokens(previous.clone()),
                };
            }
            Err(format_dropbox_restore_error(
                "Dropbox credential promotion failed durable read-back verification",
                restore,
            ))
        }
        Err(error) => {
            let restore = restore_active_dropbox_credentials_with(
                &previous,
                &mut read_active,
                &mut write_active,
            );
            if restore.is_err() {
                entry.phase = DropboxStagedCredentialPhase::Promoted {
                    previous: DropboxPreviousCredentials::from_tokens(previous.clone()),
                };
            }
            Err(format_dropbox_restore_error(
                &format!("Dropbox credential promotion read-back failed: {error}"),
                restore,
            ))
        }
    }
}

fn promote_staged_dropbox_credentials_with_journal<
    ReadBackend,
    ReadPrevious,
    ReadActive,
    WriteActive,
    WriteCandidateFallback,
    ReadJournal,
    WriteJournal,
>(
    entries: &mut HashMap<String, DropboxStagedCredential>,
    credential_handle: &str,
    client_id: &str,
    now: i64,
    mut read_backend: ReadBackend,
    mut read_previous: ReadPrevious,
    mut read_active: ReadActive,
    mut write_active: WriteActive,
    mut write_candidate_fallback: WriteCandidateFallback,
    mut read_journal: ReadJournal,
    mut write_journal: WriteJournal,
) -> Result<(), String>
where
    ReadBackend: FnMut() -> Result<String, String>,
    ReadPrevious: FnMut() -> Result<DropboxPreviousCredentials, String>,
    ReadActive: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
    WriteActive: FnMut(Option<&DropboxTokenBundle>) -> Result<(), String>,
    WriteCandidateFallback: FnMut(&DropboxTokenBundle) -> Result<(), String>,
    ReadJournal: FnMut() -> Result<Option<DropboxCredentialPromotionJournal>, String>,
    WriteJournal: FnMut(&DropboxCredentialPromotionJournal) -> Result<(), String>,
{
    if read_backend()?.trim() != "off" {
        return Err("Dropbox credentials can only be changed while sync is disabled".to_string());
    }

    let entry = staged_dropbox_entry_mut(entries, credential_handle, client_id, now)?;
    let candidate = entry.tokens.clone();
    if matches!(entry.phase, DropboxStagedCredentialPhase::Promoted { .. }) {
        let journal = read_journal()?.ok_or_else(|| {
            "Promoted Dropbox credentials are missing their durable recovery journal".to_string()
        })?;
        if !journal_matches_candidate(&journal, &candidate)? {
            return Err(
                "Promoted Dropbox credentials do not match their durable recovery journal"
                    .to_string(),
            );
        }
        return promote_staged_dropbox_credentials_with(
            entries,
            credential_handle,
            client_id,
            now,
            read_active,
            write_active,
        );
    }

    let previous = read_previous()?;
    let journal = build_dropbox_promotion_journal_with_previous(previous.clone(), &candidate)?;
    write_journal(&journal)?;
    if read_journal()?.as_ref() != Some(&journal) {
        return Err(
            "Dropbox credential promotion journal failed durable read-back verification"
                .to_string(),
        );
    }
    if !matches!(previous, DropboxPreviousCredentials::UnknownKeyring)
        && read_active()? != previous.cloned_tokens()
    {
        return Err("Active Dropbox credentials changed before journaled promotion".to_string());
    }
    if read_backend()?.trim() != "off" {
        return Err(
            "Sync backend changed before Dropbox credential promotion could complete".to_string(),
        );
    }

    if matches!(previous, DropboxPreviousCredentials::UnknownKeyring) {
        let entry = staged_dropbox_entry_mut(entries, credential_handle, client_id, now)?;
        if let Err(error) = write_candidate_fallback(&candidate) {
            entry.phase = DropboxStagedCredentialPhase::Promoted {
                previous: DropboxPreviousCredentials::UnknownKeyring,
            };
            return Err(format!(
                "Failed to promote Dropbox credentials while the previous keyring state was unavailable: {error}"
            ));
        }
        entry.phase = DropboxStagedCredentialPhase::Promoted {
            previous: DropboxPreviousCredentials::UnknownKeyring,
        };
        return match read_active() {
            Ok(active) if active.as_ref() == Some(&candidate) => Ok(()),
            Ok(_) => Err(
                "Dropbox credential promotion failed durable read-back verification while the previous keyring state was unavailable"
                    .to_string(),
            ),
            Err(error) => Err(format!(
                "Dropbox credential promotion read-back failed while the previous keyring state was unavailable: {error}"
            )),
        };
    }

    promote_staged_dropbox_credentials_with(
        entries,
        credential_handle,
        client_id,
        now,
        read_active,
        write_active,
    )?;
    staged_dropbox_entry_mut(entries, credential_handle, client_id, now)?.phase =
        DropboxStagedCredentialPhase::Promoted { previous };
    Ok(())
}

fn rollback_staged_dropbox_credentials_with<ReadActive, WriteActive>(
    entries: &mut HashMap<String, DropboxStagedCredential>,
    credential_handle: &str,
    client_id: &str,
    now: i64,
    mut read_active: ReadActive,
    mut write_active: WriteActive,
) -> Result<(), String>
where
    ReadActive: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
    WriteActive: FnMut(Option<&DropboxTokenBundle>) -> Result<(), String>,
{
    let phase = staged_dropbox_entry_mut(entries, credential_handle, client_id, now)?
        .phase
        .clone();
    match phase {
        DropboxStagedCredentialPhase::Candidate => {
            entries.remove(credential_handle);
            Ok(())
        }
        DropboxStagedCredentialPhase::Promoted { previous } => {
            if matches!(previous, DropboxPreviousCredentials::UnknownKeyring) {
                return Err(
                    "Previous Dropbox keyring state is still unavailable for rollback".to_string(),
                );
            }
            let previous_tokens = previous.cloned_tokens();
            write_active(previous_tokens.as_ref())?;
            let restored = read_active()?;
            if restored != previous_tokens {
                return Err(
                    "Previous Dropbox credentials failed durable read-back verification"
                        .to_string(),
                );
            }
            entries.remove(credential_handle);
            Ok(())
        }
    }
}

fn settle_unknown_dropbox_previous_after_recovery_with<
    ResolvePrevious,
    ClearCandidateFallback,
    ReadActive,
>(
    candidate: &DropboxTokenBundle,
    mut resolve_previous: ResolvePrevious,
    mut clear_candidate_fallback: ClearCandidateFallback,
    mut read_active: ReadActive,
) -> Result<(), String>
where
    ResolvePrevious:
        FnMut(&DropboxCredentialPromotionJournal) -> Result<DropboxPreviousCredentials, String>,
    ClearCandidateFallback: FnMut() -> Result<(), String>,
    ReadActive: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
{
    let synthetic_journal = build_dropbox_promotion_journal_with_previous(
        DropboxPreviousCredentials::UnknownKeyring,
        candidate,
    )?;
    let previous = resolve_previous(&synthetic_journal)?;
    if matches!(previous, DropboxPreviousCredentials::UnknownKeyring) {
        return Err("Previous Dropbox keyring state remains unknown".to_string());
    }
    // Unknown promotion is fallback-only. Remove and verify only those
    // candidate bytes; the token keyring is untouched even when it happens to
    // equal the candidate.
    clear_candidate_fallback()?;
    if read_active()? != previous.cloned_tokens() {
        return Err(
            "Previous Dropbox credentials failed durable rollback verification".to_string(),
        );
    }
    Ok(())
}

fn finalize_staged_dropbox_credentials_in_store(
    entries: &mut HashMap<String, DropboxStagedCredential>,
    credential_handle: &str,
    client_id: &str,
    now: i64,
) -> Result<(), String> {
    let phase = staged_dropbox_entry_mut(entries, credential_handle, client_id, now)?
        .phase
        .clone();
    if !matches!(phase, DropboxStagedCredentialPhase::Promoted { .. }) {
        return Err("Dropbox credentials cannot be finalized before promotion".to_string());
    }
    entries.remove(credential_handle);
    Ok(())
}

fn complete_committed_dropbox_finalize_with<RecordResolved, RemoveStaged, ClearJournal>(
    mut record_resolved: RecordResolved,
    mut remove_staged: RemoveStaged,
    mut clear_journal: ClearJournal,
) -> Result<(), String>
where
    RecordResolved: FnMut() -> Result<(), String>,
    RemoveStaged: FnMut() -> Result<(), String>,
    ClearJournal: FnMut() -> Result<(), String>,
{
    record_resolved()?;
    remove_staged()?;
    clear_journal()
}

fn discard_staged_dropbox_credentials_in_store(
    entries: &mut HashMap<String, DropboxStagedCredential>,
    credential_handle: &str,
    client_id: &str,
    now: i64,
) -> Result<(), String> {
    prune_expired_staged_dropbox_credentials(entries, now);
    let Some(entry) = entries.get(credential_handle) else {
        return Ok(());
    };
    if entry.tokens.client_id != client_id {
        return Err("Dropbox credential handle belongs to a different app key".to_string());
    }
    if matches!(entry.phase, DropboxStagedCredentialPhase::Promoted { .. }) {
        return Err("Promoted Dropbox credentials must be rolled back, not discarded".to_string());
    }
    entries.remove(credential_handle);
    Ok(())
}

// The saved Proxy URL must reach every native request: env vars
// (HTTP_PROXY/HTTPS_PROXY) still apply as reqwest defaults when no proxy is
// configured in the app (#864).
// TLS backend split (#663, #973): Windows must use native-tls (schannel) —
// corporate TLS interception like Zscaler needs the OS chain engine
// (intermediate/enterprise cert stores, AIA fetching), which rustls with
// native roots cannot do, so it fails with "UnknownIssuer" where curl works.
// macOS must use rustls — Secure Transport never gained TLS 1.3, so
// TLS-1.3-only servers reject it with "bad protocol version". Linux keeps
// rustls with native roots (covers private CAs in the system store).
// Known ceiling: schannel on Windows 10 has no TLS 1.3, matching 1.1.0-1.1.5.
fn blocking_http_client_builder(
    proxy_url: Option<&str>,
) -> Result<reqwest::blocking::ClientBuilder, String> {
    let builder =
        reqwest::blocking::Client::builder().timeout(Duration::from_secs(NATIVE_HTTP_TIMEOUT_SECS));
    #[cfg(target_os = "windows")]
    let mut builder = builder.use_native_tls();
    #[cfg(not(target_os = "windows"))]
    let mut builder = builder.use_rustls_tls();
    if let Some(url) = proxy_url.map(str::trim).filter(|url| !url.is_empty()) {
        let proxy = reqwest::Proxy::all(url)
            .map_err(|error| format!("Invalid proxy URL ({url}): {error}"))?;
        builder = builder.proxy(proxy);
    }
    Ok(builder)
}

fn blocking_http_client(proxy_url: Option<&str>) -> Result<reqwest::blocking::Client, String> {
    blocking_http_client_builder(proxy_url)?
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))
}

fn is_https_downgrade(next: &reqwest::Url, previous: &[reqwest::Url]) -> bool {
    previous
        .last()
        .is_some_and(|previous| previous.scheme() == "https" && next.scheme() == "http")
}

fn webdav_redirect_security_error(
    next: &reqwest::Url,
    previous: &[reqwest::Url],
    allow_insecure_http: bool,
) -> Option<&'static str> {
    if is_https_downgrade(next, previous) {
        Some("WebDAV refused an HTTPS to HTTP redirect")
    } else if assert_webdav_url_allowed(next.as_str(), allow_insecure_http).is_err() {
        Some("WebDAV refused an insecure redirect target")
    } else {
        None
    }
}

fn cloud_redirect_security_error(
    next: &reqwest::Url,
    previous: &[reqwest::Url],
    allow_insecure_http: bool,
) -> Option<&'static str> {
    if is_https_downgrade(next, previous) {
        Some("Cloud sync refused an HTTPS to HTTP redirect")
    } else if assert_cloud_url_allowed(next.as_str(), allow_insecure_http).is_err() {
        Some("Cloud sync refused an insecure redirect target")
    } else {
        None
    }
}

/// reqwest's default `Policy::limited(10)` re-sends the request -- body included -- at
/// whatever host the Location points at. Sync requests carry the whole document, so both
/// backends check the redirect target against their own URL rule before following.
fn redirect_guarded_blocking_http_client(
    proxy_url: Option<&str>,
    label: &'static str,
    security_error: impl Fn(&reqwest::Url, &[reqwest::Url]) -> Option<&'static str>
        + Send
        + Sync
        + 'static,
) -> Result<reqwest::blocking::Client, String> {
    let redirect_policy = reqwest::redirect::Policy::custom(move |attempt| {
        if let Some(error) = security_error(attempt.url(), attempt.previous()) {
            attempt.error(error)
        } else if attempt.previous().len() > 10 {
            attempt.error(format!("too many {label} redirects"))
        } else {
            attempt.follow()
        }
    });
    blocking_http_client_builder(proxy_url)?
        .redirect(redirect_policy)
        .build()
        .map_err(|error| format!("Failed to create {label} HTTP client: {error}"))
}

fn webdav_blocking_http_client(
    proxy_url: Option<&str>,
    allow_insecure_http: bool,
) -> Result<reqwest::blocking::Client, String> {
    redirect_guarded_blocking_http_client(proxy_url, "WebDAV", move |next, previous| {
        webdav_redirect_security_error(next, previous, allow_insecure_http)
    })
}

fn cloud_blocking_http_client(
    proxy_url: Option<&str>,
    allow_insecure_http: bool,
) -> Result<reqwest::blocking::Client, String> {
    redirect_guarded_blocking_http_client(proxy_url, "Cloud", move |next, previous| {
        cloud_redirect_security_error(next, previous, allow_insecure_http)
    })
}

// The Dropbox token endpoint is a fixed, non-configurable host -- unlike WebDAV/Cloud
// there is no "allow insecure http" knob, and no reason to ever follow a redirect off
// api.dropboxapi.com since the POST body carries the refresh token / client id.
fn dropbox_redirect_security_error(
    next: &reqwest::Url,
    previous: &[reqwest::Url],
) -> Option<&'static str> {
    let allowed_host = reqwest::Url::parse(DROPBOX_TOKEN_ENDPOINT)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string));
    if is_https_downgrade(next, previous) {
        Some("Dropbox refused an HTTPS to HTTP redirect")
    } else if next.scheme() != "https" || Some(next.host_str().unwrap_or_default().to_string()) != allowed_host {
        Some("Dropbox refused a redirect off the token endpoint")
    } else {
        None
    }
}

fn dropbox_blocking_http_client(
    proxy_url: Option<&str>,
) -> Result<reqwest::blocking::Client, String> {
    redirect_guarded_blocking_http_client(proxy_url, "Dropbox", dropbox_redirect_security_error)
}

fn app_blocking_http_client(app: &tauri::AppHandle) -> Result<reqwest::blocking::Client, String> {
    blocking_http_client(read_config(app).proxy_url.as_deref())
}

fn format_error_with_source_chain(
    label: &str,
    error: &(dyn StdError + 'static),
    categories: &[&str],
) -> String {
    let root_message = error.to_string();
    let category_suffix = if categories.is_empty() {
        String::new()
    } else {
        format!(" [{}]", categories.join(","))
    };
    let mut message = format!("{label}{category_suffix}: {root_message}");
    let mut causes: Vec<String> = Vec::new();
    let mut source = error.source();

    while let Some(cause) = source {
        let detail = cause.to_string();
        if !detail.is_empty()
            && detail != root_message
            && !causes.iter().any(|existing| existing == &detail)
        {
            causes.push(detail);
        }
        source = cause.source();
    }

    if !causes.is_empty() {
        message.push_str(" (caused by: ");
        message.push_str(&causes.join(" -> "));
        message.push(')');
    }

    message
}

fn reqwest_error_categories(error: &reqwest::Error) -> Vec<&'static str> {
    let mut categories = Vec::new();
    if error.is_timeout() {
        categories.push("timeout");
    }
    if error.is_connect() {
        categories.push("connect");
    }
    if error.is_request() {
        categories.push("request");
    }
    if error.is_builder() {
        categories.push("builder");
    }
    if error.is_redirect() {
        categories.push("redirect");
    }
    if error.is_status() {
        categories.push("status");
    }
    if error.is_body() {
        categories.push("body");
    }
    if error.is_decode() {
        categories.push("decode");
    }
    categories
}

fn format_reqwest_send_error(label: &str, error: &reqwest::Error) -> String {
    let categories = reqwest_error_categories(error);
    format_error_with_source_chain(label, error, &categories)
}

fn header_value_to_string(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
}

fn normalize_strong_webdav_etag(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.len() < 2
        || value
            .get(..2)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("W/"))
        || !value.starts_with('"')
        || !value.ends_with('"')
    {
        return None;
    }
    let opaque = &value[1..value.len() - 1];
    if opaque
        .chars()
        .any(|ch| ch == '"' || ch.is_control() || ch == ' ')
    {
        return None;
    }
    Some(value.to_string())
}

fn strong_webdav_etag_from_headers(headers: &reqwest::header::HeaderMap) -> Option<String> {
    normalize_strong_webdav_etag(header_value_to_string(headers, "etag").as_deref())
}

fn invalid_webdav_document_error(message: String, strong_etag: Option<&str>) -> String {
    format!(
        "{message} [{WEBDAV_VERSION_MARKER}:existing:{}]",
        strong_etag.unwrap_or("none")
    )
}

fn webdav_write_condition(
    expected_etag: Option<&str>,
) -> Result<(reqwest::header::HeaderName, reqwest::header::HeaderValue), String> {
    match expected_etag {
        None => Ok((
            reqwest::header::IF_NONE_MATCH,
            reqwest::header::HeaderValue::from_static("*"),
        )),
        Some(expected) => {
            let strong = normalize_strong_webdav_etag(Some(expected))
                .ok_or_else(|| "WebDAV replacement requires a valid strong ETag".to_string())?;
            let value = reqwest::header::HeaderValue::from_str(&strong)
                .map_err(|_| "WebDAV replacement ETag is not a valid HTTP header".to_string())?;
            Ok((reqwest::header::IF_MATCH, value))
        }
    }
}

fn remote_json_write_result_from_headers(
    headers: &reqwest::header::HeaderMap,
) -> RemoteJsonWriteResult {
    RemoteJsonWriteResult {
        fingerprint: None,
        etag: header_value_to_string(headers, "etag"),
        last_modified: header_value_to_string(headers, "last-modified"),
        content_length: header_value_to_string(headers, "content-length"),
        server_merged_remote_data: None,
    }
}

fn apply_cloud_write_response_body(result: &mut RemoteJsonWriteResult, body: &str) {
    let normalized_body = body.trim_start_matches('\u{feff}').trim();
    if normalized_body.is_empty() {
        return;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(normalized_body) else {
        return;
    };
    if let Some(value) = parsed.get("remoteFingerprint").and_then(Value::as_str) {
        if !value.trim().is_empty() {
            result.fingerprint = Some(value.to_string());
        }
    }
    if let Some(value) = parsed.get("etag").and_then(Value::as_str) {
        result.etag = Some(value.to_string());
    }
    if let Some(value) = parsed.get("lastModified").and_then(Value::as_str) {
        result.last_modified = Some(value.to_string());
    }
    if let Some(value) = parsed.get("contentLength").and_then(Value::as_str) {
        result.content_length = Some(value.to_string());
    }
    if let Some(value) = parsed
        .get("serverMergedRemoteData")
        .and_then(Value::as_bool)
    {
        result.server_merged_remote_data = Some(value);
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_dropbox_client_id(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Dropbox app key is required".to_string());
    }
    Ok(trimmed.to_string())
}

fn dropbox_redirect_uri() -> String {
    format!(
        "http://{}:{}{}",
        DROPBOX_REDIRECT_HOST, DROPBOX_REDIRECT_PORT, DROPBOX_REDIRECT_PATH
    )
}

fn decode_query_component(raw: &str) -> String {
    let mut bytes: Vec<u8> = Vec::with_capacity(raw.len());
    let mut idx = 0usize;
    let raw_bytes = raw.as_bytes();
    while idx < raw_bytes.len() {
        match raw_bytes[idx] {
            b'+' => {
                bytes.push(b' ');
                idx += 1;
            }
            b'%' if idx + 2 < raw_bytes.len() => {
                let hex = &raw[idx + 1..idx + 3];
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    bytes.push(value);
                    idx += 3;
                } else {
                    bytes.push(raw_bytes[idx]);
                    idx += 1;
                }
            }
            value => {
                bytes.push(value);
                idx += 1;
            }
        }
    }
    String::from_utf8_lossy(&bytes).to_string()
}

fn parse_query_string(query: &str) -> HashMap<String, String> {
    let mut values: HashMap<String, String> = HashMap::new();
    for part in query.split('&') {
        if part.is_empty() {
            continue;
        }
        let (key, value) = match part.split_once('=') {
            Some((key, value)) => (key, value),
            None => (part, ""),
        };
        values.insert(decode_query_component(key), decode_query_component(value));
    }
    values
}

fn write_oauth_http_response(
    stream: &mut std::net::TcpStream,
    status_line: &str,
    body: &str,
) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status_line}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|error| format!("Failed to write OAuth response: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("Failed to flush OAuth response: {error}"))?;
    Ok(())
}

fn wait_for_dropbox_auth_code(
    listener: &TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(DROPBOX_OAUTH_TIMEOUT_SECS);
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buffer = [0u8; 8192];
                let read_len = stream
                    .read(&mut buffer)
                    .map_err(|error| format!("Failed to read OAuth callback: {error}"))?;
                if read_len == 0 {
                    continue;
                }
                let request = String::from_utf8_lossy(&buffer[..read_len]);
                let request_line = request
                    .lines()
                    .next()
                    .ok_or_else(|| "Invalid OAuth callback request".to_string())?;
                let target = request_line.split_whitespace().nth(1).unwrap_or("/");
                if !target.starts_with(DROPBOX_REDIRECT_PATH) {
                    let _ = write_oauth_http_response(
                        &mut stream,
                        "404 Not Found",
                        "Mindwtr OAuth callback endpoint not found.",
                    );
                    continue;
                }

                let query = target.split_once('?').map(|(_, query)| query).unwrap_or("");
                let params = parse_query_string(query);

                if let Some(error_value) = params.get("error") {
                    let details = params
                        .get("error_description")
                        .or_else(|| params.get("error_summary"))
                        .cloned()
                        .unwrap_or_else(|| error_value.clone());
                    let _ = write_oauth_http_response(
                        &mut stream,
                        "400 Bad Request",
                        "Dropbox authorization failed. You can return to Mindwtr.",
                    );
                    return Err(format!("Dropbox authorization failed: {details}"));
                }

                let state = params.get("state").cloned().unwrap_or_default();
                if state != expected_state {
                    let _ = write_oauth_http_response(
                        &mut stream,
                        "400 Bad Request",
                        "Dropbox state validation failed. Please retry from Mindwtr.",
                    );
                    return Err("Dropbox authorization failed: state mismatch".to_string());
                }

                let code = params.get("code").cloned().unwrap_or_default();
                if code.trim().is_empty() {
                    let _ = write_oauth_http_response(
                        &mut stream,
                        "400 Bad Request",
                        "Dropbox authorization failed. Missing authorization code.",
                    );
                    return Err("Dropbox authorization failed: missing code".to_string());
                }

                let _ = write_oauth_http_response(
                    &mut stream,
                    "200 OK",
                    "Dropbox connected. You can close this tab and return to Mindwtr.",
                );
                return Ok(code);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(format!("Failed to accept OAuth callback: {error}"));
            }
        }
    }
    Err("Dropbox authorization timed out. Please try again.".to_string())
}

fn generate_random_urlsafe(size: usize) -> String {
    let mut bytes = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn generate_dropbox_pkce_verifier() -> String {
    generate_random_urlsafe(64)
}

fn generate_dropbox_pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn dropbox_token_error_message(status: StatusCode, response_body: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<DropboxTokenResponse>(response_body) {
        if let Some(message) = parsed.error_description {
            let trimmed = message.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Some(message) = parsed.error_summary {
            let trimmed = message.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    format!("HTTP {status}")
}

fn exchange_dropbox_auth_code(
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    proxy_url: Option<&str>,
) -> Result<DropboxTokenBundle, String> {
    let client = dropbox_blocking_http_client(proxy_url)?;
    let response = client
        .post(DROPBOX_TOKEN_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ])
        .send()
        .map_err(|error| format!("Dropbox token exchange failed: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("Failed to read Dropbox token response: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Dropbox token exchange failed: {}",
            dropbox_token_error_message(status, &body)
        ));
    }
    let payload: DropboxTokenResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Dropbox token exchange returned invalid JSON: {error}"))?;
    let access_token = payload.access_token.unwrap_or_default().trim().to_string();
    let refresh_token = payload.refresh_token.unwrap_or_default().trim().to_string();
    let expires_in = payload
        .expires_in
        .filter(|value| *value > 0)
        .unwrap_or(DROPBOX_DEFAULT_TOKEN_LIFETIME_SECS);
    if access_token.is_empty() || refresh_token.is_empty() {
        return Err("Dropbox token exchange returned an invalid payload".to_string());
    }
    Ok(DropboxTokenBundle {
        client_id: client_id.to_string(),
        access_token,
        refresh_token,
        expires_at: now_unix_ms() + expires_in * 1000,
    })
}

fn refresh_dropbox_token(
    client_id: &str,
    refresh_token: &str,
    proxy_url: Option<&str>,
) -> Result<(String, i64), String> {
    let client = dropbox_blocking_http_client(proxy_url)?;
    let response = client
        .post(DROPBOX_TOKEN_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ])
        .send()
        .map_err(|error| format!("Dropbox token refresh failed: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("Failed to read Dropbox refresh response: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Dropbox token refresh failed: {}",
            dropbox_token_error_message(status, &body)
        ));
    }
    let payload: DropboxTokenResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Dropbox token refresh returned invalid JSON: {error}"))?;
    let access_token = payload.access_token.unwrap_or_default().trim().to_string();
    let expires_in = payload
        .expires_in
        .filter(|value| *value > 0)
        .unwrap_or(DROPBOX_DEFAULT_TOKEN_LIFETIME_SECS);
    if access_token.is_empty() {
        return Err("Dropbox token refresh returned an invalid payload".to_string());
    }
    Ok((access_token, now_unix_ms() + expires_in * 1000))
}

fn validate_dropbox_token_bundle(tokens: DropboxTokenBundle) -> Result<DropboxTokenBundle, String> {
    if tokens.client_id.trim().is_empty()
        || tokens.access_token.trim().is_empty()
        || tokens.refresh_token.trim().is_empty()
    {
        return Err(
            "Stored Dropbox token payload is invalid. Please reconnect Dropbox.".to_string(),
        );
    }
    Ok(tokens)
}

fn parse_dropbox_token_bundle(raw: &str) -> Result<DropboxTokenBundle, String> {
    let parsed: DropboxTokenBundle = serde_json::from_str(raw).map_err(|_| {
        "Stored Dropbox token payload is invalid. Please reconnect Dropbox.".to_string()
    })?;
    validate_dropbox_token_bundle(parsed)
}

fn read_dropbox_tokens(app: &tauri::AppHandle) -> Result<Option<DropboxTokenBundle>, String> {
    read_dropbox_tokens_for_recovery(app)
}

fn is_dropbox_connected_with<ReadTokens>(
    client_id: &str,
    mut read_tokens: ReadTokens,
) -> Result<bool, String>
where
    ReadTokens: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
{
    Ok(read_tokens()?.is_some_and(|tokens| {
        tokens.client_id == client_id
            && !tokens.access_token.trim().is_empty()
            && !tokens.refresh_token.trim().is_empty()
    }))
}

/// Whether the credential-state file holds any trace of Dropbox ever being set
/// up. When it holds none, an unreachable keyring cannot be hiding tokens —
/// there were never any to hide — so a status probe may answer "not connected"
/// instead of erroring (#1043: keyring-less WebDAV/self-hosted setups saw a
/// Dropbox error banner for a service they never used).
fn dropbox_state_has_credential_evidence(state: &DropboxCredentialStateFile) -> bool {
    state.token_fallback.is_some()
        || state.promotion_journal.is_some()
        || !state.resolved_credential_handles.is_empty()
        || state.cloud_provider.trim() == "dropbox"
}

/// A failed connection-status probe stays an error only while Dropbox evidence
/// exists (a real setup whose keyring is unreachable deserves the loud path);
/// with no evidence the probe answers "not connected".
fn dropbox_status_probe_outcome(
    result: Result<bool, String>,
    has_credential_evidence: bool,
) -> Result<bool, String> {
    match result {
        Err(error) if !has_credential_evidence => {
            log::warn!(
                "Dropbox status check failed with no stored Dropbox credentials; reporting disconnected: {error}"
            );
            Ok(false)
        }
        other => other,
    }
}

fn read_dropbox_tokens_for_recovery_with<ReadKeyring, ReadFallback>(
    mut read_keyring: ReadKeyring,
    mut read_fallback: ReadFallback,
) -> Result<Option<DropboxTokenBundle>, String>
where
    ReadKeyring: FnMut() -> Result<Option<String>, String>,
    ReadFallback: FnMut() -> Result<Option<String>, String>,
{
    let raw = match read_fallback()? {
        Some(fallback) => Some(fallback),
        None => match read_keyring() {
            Ok(raw) => raw,
            Err(_) => {
                return Err("Failed to inspect Dropbox credentials during recovery".to_string())
            }
        },
    };
    raw.map(|raw| parse_dropbox_token_bundle(&raw)).transpose()
}

fn read_dropbox_previous_credentials_for_promotion_with<ReadKeyring, ReadFallback>(
    mut read_keyring: ReadKeyring,
    mut read_fallback: ReadFallback,
) -> Result<DropboxPreviousCredentials, String>
where
    ReadKeyring: FnMut() -> Result<Option<String>, String>,
    ReadFallback: FnMut() -> Result<Option<String>, String>,
{
    if let Some(raw) = read_fallback()? {
        return parse_dropbox_token_bundle(&raw).map(DropboxPreviousCredentials::Bundle);
    }
    match read_keyring() {
        Ok(Some(raw)) => parse_dropbox_token_bundle(&raw).map(DropboxPreviousCredentials::Bundle),
        Ok(None) => Ok(DropboxPreviousCredentials::Empty),
        Err(_) => Ok(DropboxPreviousCredentials::UnknownKeyring),
    }
}

fn read_dropbox_tokens_fallback(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(read_dropbox_credential_state(app)?.token_fallback)
}

fn read_dropbox_tokens_for_recovery(
    app: &tauri::AppHandle,
) -> Result<Option<DropboxTokenBundle>, String> {
    read_dropbox_tokens_for_recovery_with(
        || get_keyring_secret(app, KEYRING_DROPBOX_TOKENS),
        || read_dropbox_tokens_fallback(app),
    )
}

fn read_dropbox_previous_credentials_for_promotion(
    app: &tauri::AppHandle,
) -> Result<DropboxPreviousCredentials, String> {
    read_dropbox_previous_credentials_for_promotion_with(
        || get_keyring_secret(app, KEYRING_DROPBOX_TOKENS),
        || read_dropbox_tokens_fallback(app),
    )
}

fn write_dropbox_tokens(app: &tauri::AppHandle, tokens: &DropboxTokenBundle) -> Result<(), String> {
    let payload = serde_json::to_string(tokens)
        .map_err(|error| format!("Failed to serialize Dropbox tokens: {error}"))?;
    let keyring_verified = set_keyring_secret(app, KEYRING_DROPBOX_TOKENS, Some(payload.clone()))
        .and_then(|_| {
            get_keyring_secret(app, KEYRING_DROPBOX_TOKENS).map(|raw| raw == Some(payload.clone()))
        })
        .unwrap_or(false);
    if keyring_verified {
        update_dropbox_credential_state(app, |state| {
            state.token_fallback = None;
            Ok(())
        })?;
    } else {
        update_dropbox_credential_state(app, |state| {
            state.token_fallback = Some(payload.clone());
            Ok(())
        })?;
        crate::config::emit_keyring_fallback_warning(app, "Dropbox credentials");
    }
    Ok(())
}

fn write_dropbox_tokens_fallback_only(
    app: &tauri::AppHandle,
    tokens: &DropboxTokenBundle,
) -> Result<(), String> {
    let payload = serde_json::to_string(tokens)
        .map_err(|error| format!("Failed to serialize Dropbox tokens: {error}"))?;
    update_dropbox_credential_state(app, |state| {
        state.token_fallback = Some(payload.clone());
        Ok(())
    })?;
    if read_dropbox_credential_state(app)?
        .token_fallback
        .as_deref()
        != Some(payload.as_str())
    {
        return Err(
            "Dropbox credential fallback failed durable read-back verification".to_string(),
        );
    }
    crate::config::emit_keyring_fallback_warning(app, "Dropbox credentials");
    Ok(())
}

fn clear_dropbox_tokens_fallback_only(app: &tauri::AppHandle) -> Result<(), String> {
    update_dropbox_credential_state(app, |state| {
        state.token_fallback = None;
        Ok(())
    })?;
    if read_dropbox_credential_state(app)?.token_fallback.is_some() {
        return Err("Dropbox credential fallback failed durable deletion verification".to_string());
    }
    Ok(())
}

fn clear_dropbox_tokens_with<ClearFallback, ReadFallback, ReadKeyring, DeleteKeyring>(
    mut clear_fallback: ClearFallback,
    mut fallback_has_tokens: ReadFallback,
    mut keyring_has_tokens: ReadKeyring,
    mut delete_keyring_tokens: DeleteKeyring,
) -> Result<(), String>
where
    ClearFallback: FnMut() -> Result<(), String>,
    ReadFallback: FnMut() -> Result<bool, String>,
    ReadKeyring: FnMut() -> Result<bool, String>,
    DeleteKeyring: FnMut() -> Result<(), String>,
{
    // Clear the file fallback first. `read_config` may migrate a legacy file
    // secret into the keyring, so deleting the keyring first can immediately
    // recreate the credential from secrets.toml.
    clear_fallback()
        .map_err(|error| format!("Failed to clear Dropbox credential fallback: {error}"))?;
    if fallback_has_tokens()
        .map_err(|error| format!("Failed to verify Dropbox credential fallback: {error}"))?
    {
        return Err(
            "Dropbox credential fallback failed durable read-back verification".to_string(),
        );
    }

    if keyring_has_tokens()
        .map_err(|error| format!("Failed to inspect Dropbox credentials in the keyring: {error}"))?
    {
        delete_keyring_tokens().map_err(|error| {
            format!("Failed to delete Dropbox credentials from the keyring: {error}")
        })?;
    }
    if keyring_has_tokens()
        .map_err(|error| format!("Failed to verify Dropbox keyring deletion: {error}"))?
    {
        return Err("Dropbox keyring deletion failed durable read-back verification".to_string());
    }

    // A fallback read can itself trigger the legacy migration. Recheck the
    // keyring last so success proves both durable locations are empty at the
    // same point in time.
    if fallback_has_tokens()
        .map_err(|error| format!("Failed to recheck Dropbox credential fallback: {error}"))?
    {
        return Err(
            "Dropbox credential fallback failed durable read-back verification".to_string(),
        );
    }
    if keyring_has_tokens()
        .map_err(|error| format!("Failed to recheck Dropbox keyring deletion: {error}"))?
    {
        return Err("Dropbox credentials reappeared in the keyring during deletion".to_string());
    }
    Ok(())
}

fn clear_dropbox_tokens(app: &tauri::AppHandle) -> Result<(), String> {
    clear_dropbox_tokens_with(
        || {
            update_dropbox_credential_state(app, |state| {
                state.token_fallback = None;
                Ok(())
            })
            .map(|_| ())
        },
        || Ok(read_dropbox_credential_state(app)?.token_fallback.is_some()),
        || get_keyring_secret(app, KEYRING_DROPBOX_TOKENS).map(|value| value.is_some()),
        || set_keyring_secret(app, KEYRING_DROPBOX_TOKENS, None),
    )
}

fn publish_dropbox_disconnect_state(app: &tauri::AppHandle) -> Result<(), String> {
    let tombstone = serialize_dropbox_journal_tombstone()?;
    let persisted = update_dropbox_credential_state(app, |state| {
        // One protected publication removes active fallback authority and
        // logically clears any promotion journal before either keyring entry
        // can be deleted or the remote token can be revoked.
        state.token_fallback = None;
        state.promotion_journal = Some(tombstone.clone());
        Ok(())
    })?;
    if persisted.token_fallback.is_some()
        || persisted.promotion_journal.as_deref() != Some(tombstone.as_str())
    {
        return Err("Dropbox disconnect state failed durable read-back verification".to_string());
    }
    Ok(())
}

fn clear_dropbox_tokens_after_disconnect_state_publish(
    app: &tauri::AppHandle,
) -> Result<(), String> {
    clear_dropbox_tokens_with(
        || Ok(()),
        || Ok(read_dropbox_credential_state(app)?.token_fallback.is_some()),
        || get_keyring_secret(app, KEYRING_DROPBOX_TOKENS).map(|value| value.is_some()),
        || set_keyring_secret(app, KEYRING_DROPBOX_TOKENS, None),
    )
}

fn clear_dropbox_credentials_for_disconnect(app: &tauri::AppHandle) -> Result<(), String> {
    publish_dropbox_disconnect_state(app)?;
    clear_dropbox_tokens_after_disconnect_state_publish(app)
}

fn write_optional_dropbox_tokens(
    app: &tauri::AppHandle,
    tokens: Option<&DropboxTokenBundle>,
) -> Result<(), String> {
    match tokens {
        Some(tokens) => write_dropbox_tokens(app, tokens),
        None => clear_dropbox_tokens(app),
    }
}

fn validate_dropbox_promotion_journal(
    journal: DropboxCredentialPromotionJournal,
) -> Result<DropboxCredentialPromotionJournal, String> {
    if journal.candidate_client_id.trim().is_empty()
        || journal.candidate_fingerprint.trim().is_empty()
    {
        return Err("Dropbox credential promotion journal is invalid".to_string());
    }
    if let DropboxPreviousCredentials::Bundle(tokens) = &journal.previous {
        validate_dropbox_token_bundle(tokens.clone())?;
    }
    Ok(journal)
}

fn parse_dropbox_promotion_journal_fallback_record(
    raw: &str,
) -> Result<DropboxPromotionJournalFallbackRecord, String> {
    if let Ok(record) = serde_json::from_str::<DropboxPromotionJournalFallbackRecord>(raw) {
        return match record {
            DropboxPromotionJournalFallbackRecord::PendingKeyring {
                version,
                journal_fingerprint,
            } if version == DROPBOX_PROMOTION_JOURNAL_VERSION
                && !journal_fingerprint.trim().is_empty() =>
            {
                Ok(DropboxPromotionJournalFallbackRecord::PendingKeyring {
                    version,
                    journal_fingerprint,
                })
            }
            DropboxPromotionJournalFallbackRecord::PendingKeyring { .. } => Err(
                "Dropbox credential promotion keyring marker has an unsupported version"
                    .to_string(),
            ),
            DropboxPromotionJournalFallbackRecord::Pending { journal } => {
                validate_dropbox_promotion_journal(journal)
                    .map(|journal| DropboxPromotionJournalFallbackRecord::Pending { journal })
            }
            DropboxPromotionJournalFallbackRecord::Cleared { version }
                if version == DROPBOX_PROMOTION_JOURNAL_VERSION =>
            {
                Ok(DropboxPromotionJournalFallbackRecord::Cleared { version })
            }
            DropboxPromotionJournalFallbackRecord::Cleared { .. } => {
                Err("Dropbox credential promotion tombstone has an unsupported version".to_string())
            }
        };
    }

    let journal: DropboxCredentialPromotionJournal = serde_json::from_str(raw)
        .map_err(|_| "Dropbox credential promotion journal is invalid".to_string())?;
    validate_dropbox_promotion_journal(journal)
        .map(|journal| DropboxPromotionJournalFallbackRecord::Pending { journal })
}

fn serialize_dropbox_pending_journal_fallback(
    journal: &DropboxCredentialPromotionJournal,
) -> Result<String, String> {
    serde_json::to_string(&DropboxPromotionJournalFallbackRecord::Pending {
        journal: journal.clone(),
    })
    .map_err(|_| "Failed to serialize the Dropbox credential promotion journal".to_string())
}

fn dropbox_promotion_journal_fingerprint(
    journal: &DropboxCredentialPromotionJournal,
) -> Result<String, String> {
    let serialized = serde_json::to_vec(journal).map_err(|_| {
        "Failed to fingerprint the Dropbox credential promotion journal".to_string()
    })?;
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(serialized)))
}

fn serialize_dropbox_pending_keyring_marker(
    journal: &DropboxCredentialPromotionJournal,
) -> Result<String, String> {
    serde_json::to_string(&DropboxPromotionJournalFallbackRecord::PendingKeyring {
        version: DROPBOX_PROMOTION_JOURNAL_VERSION,
        journal_fingerprint: dropbox_promotion_journal_fingerprint(journal)?,
    })
    .map_err(|_| "Failed to serialize the Dropbox credential promotion marker".to_string())
}

fn serialize_dropbox_journal_tombstone() -> Result<String, String> {
    serde_json::to_string(&DropboxPromotionJournalFallbackRecord::Cleared {
        version: DROPBOX_PROMOTION_JOURNAL_VERSION,
    })
    .map_err(|_| "Failed to serialize the Dropbox credential promotion tombstone".to_string())
}

fn read_dropbox_promotion_journal_authority_with<
    CanCleanupOrphan,
    WriteFallback,
    ReadFallback,
    ReadKeyring,
    ClearKeyring,
    ClearFallback,
>(
    mut can_cleanup_orphan: CanCleanupOrphan,
    mut write_fallback: WriteFallback,
    mut read_fallback: ReadFallback,
    mut read_keyring: ReadKeyring,
    mut clear_keyring: ClearKeyring,
    mut clear_fallback: ClearFallback,
) -> Result<Option<DropboxCredentialPromotionJournal>, String>
where
    CanCleanupOrphan: FnMut() -> Result<bool, String>,
    WriteFallback: FnMut(&str) -> Result<(), String>,
    ReadFallback: FnMut() -> Result<Option<String>, String>,
    ReadKeyring: FnMut() -> Result<Option<String>, String>,
    ClearKeyring: FnMut() -> Result<(), String>,
    ClearFallback: FnMut() -> Result<(), String>,
{
    // The owner-only fallback is the authority marker. Its absence means no
    // transaction and deliberately does not probe the keyring: a clean
    // profile must remain usable when the OS credential service is absent.
    let Some(raw) = read_fallback()? else {
        return Ok(None);
    };
    match parse_dropbox_promotion_journal_fallback_record(&raw)? {
        DropboxPromotionJournalFallbackRecord::PendingKeyring {
            journal_fingerprint,
            ..
        } => {
            let raw = read_keyring().map_err(|_| {
                "Failed to inspect the Dropbox credential promotion journal".to_string()
            })?;
            if let Some(raw) = raw.as_deref() {
                if let Ok(journal) = serde_json::from_str::<DropboxCredentialPromotionJournal>(raw)
                    .map_err(|_| ())
                    .and_then(|journal| validate_dropbox_promotion_journal(journal).map_err(|_| ()))
                {
                    if dropbox_promotion_journal_fingerprint(&journal)? == journal_fingerprint {
                        return Ok(Some(journal));
                    }
                }
            }

            // A missing, corrupt, or mismatched keyring journal cannot be
            // paired with this transaction-bound marker. It is safe to remove
            // only while both durable backend authorities remain off; callers
            // otherwise fail closed first and retry cleanup later.
            if !can_cleanup_orphan()? {
                return Err(
                    "Dropbox credential promotion marker does not match its keyring journal"
                        .to_string(),
                );
            }
            let tombstone = serialize_dropbox_journal_tombstone()?;
            write_fallback(&tombstone)?;
            let persisted = read_fallback()?.ok_or_else(|| {
                "Dropbox credential promotion tombstone is missing after write".to_string()
            })?;
            if !matches!(
                parse_dropbox_promotion_journal_fallback_record(&persisted)?,
                DropboxPromotionJournalFallbackRecord::Cleared { .. }
            ) {
                return Err(
                    "Dropbox credential promotion tombstone failed durable read-back verification"
                        .to_string(),
                );
            }
            clear_keyring()?;
            if !matches!(read_keyring(), Ok(None)) {
                return Err(
                    "Dropbox credential promotion orphan keyring deletion could not be verified"
                        .to_string(),
                );
            }
            let _ = clear_fallback();
            Ok(None)
        }
        DropboxPromotionJournalFallbackRecord::Pending { journal } => Ok(Some(journal)),
        DropboxPromotionJournalFallbackRecord::Cleared { .. } => {
            // The redacted fallback tombstone is the durable authority. A
            // stale or unavailable keyring cannot resurrect the resolved
            // transaction. Cleanup is opportunistic and may be retried.
            if clear_keyring().is_ok() && matches!(read_keyring(), Ok(None)) {
                let _ = clear_fallback();
            }
            Ok(None)
        }
    }
}

fn write_dropbox_promotion_journal_authority_with<WriteKeyring, WriteFallback, ReadFallback>(
    journal: &DropboxCredentialPromotionJournal,
    mut write_keyring: WriteKeyring,
    mut write_fallback: WriteFallback,
    mut read_fallback: ReadFallback,
) -> Result<(), String>
where
    WriteKeyring: FnMut(&str) -> Result<(), String>,
    WriteFallback: FnMut(&str) -> Result<(), String>,
    ReadFallback: FnMut() -> Result<Option<String>, String>,
{
    // The redacted marker is published before the keyring write. It is the
    // authority bit that distinguishes a clean profile from an interrupted
    // transaction without duplicating token bytes into secrets.toml.
    let marker = serialize_dropbox_pending_keyring_marker(journal)?;
    write_fallback(&marker)?;
    let persisted_marker = read_fallback()?.ok_or_else(|| {
        "Dropbox credential promotion keyring marker is missing after write".to_string()
    })?;
    if persisted_marker != marker {
        return Err(
            "Dropbox credential promotion keyring marker does not match the pending transaction"
                .to_string(),
        );
    }

    let keyring_payload = serde_json::to_string(journal)
        .map_err(|_| "Failed to serialize the Dropbox credential promotion journal".to_string())?;
    if write_keyring(&keyring_payload).is_ok() {
        let persisted_marker = read_fallback()?.ok_or_else(|| {
            "Dropbox credential promotion keyring marker disappeared after keyring write"
                .to_string()
        })?;
        if persisted_marker != marker {
            return Err(
                "Dropbox credential promotion keyring marker changed during journal publication"
                    .to_string(),
            );
        }
        return Ok(());
    }

    // A failed or uncertain keyring write may have left stale bytes behind.
    // Publish the owner-only fallback after that attempt so it becomes the
    // durable authority before active credentials may be overwritten.
    let fallback_payload = serialize_dropbox_pending_journal_fallback(journal)?;
    write_fallback(&fallback_payload)?;
    let persisted = read_fallback()?
        .ok_or_else(|| "Dropbox credential promotion journal is missing after write".to_string())?;
    if parse_dropbox_promotion_journal_fallback_record(&persisted)?
        != (DropboxPromotionJournalFallbackRecord::Pending {
            journal: journal.clone(),
        })
    {
        return Err(
            "Dropbox credential promotion journal failed durable read-back verification"
                .to_string(),
        );
    }
    Ok(())
}

fn logically_clear_dropbox_promotion_journal_with<
    WriteFallback,
    ReadFallback,
    ClearKeyring,
    ReadKeyring,
    ClearFallback,
>(
    mut write_fallback: WriteFallback,
    mut read_fallback: ReadFallback,
    mut clear_keyring: ClearKeyring,
    mut read_keyring: ReadKeyring,
    mut clear_fallback: ClearFallback,
) -> Result<(), String>
where
    WriteFallback: FnMut(&str) -> Result<(), String>,
    ReadFallback: FnMut() -> Result<Option<String>, String>,
    ClearKeyring: FnMut() -> Result<(), String>,
    ReadKeyring: FnMut() -> Result<Option<String>, String>,
    ClearFallback: FnMut() -> Result<(), String>,
{
    let tombstone = serialize_dropbox_journal_tombstone()?;
    write_fallback(&tombstone)?;
    let persisted = read_fallback()?.ok_or_else(|| {
        "Dropbox credential promotion tombstone is missing after write".to_string()
    })?;
    if !matches!(
        parse_dropbox_promotion_journal_fallback_record(&persisted)?,
        DropboxPromotionJournalFallbackRecord::Cleared { .. }
    ) {
        return Err(
            "Dropbox credential promotion tombstone failed durable read-back verification"
                .to_string(),
        );
    }

    if clear_keyring().is_ok() && matches!(read_keyring(), Ok(None)) {
        let _ = clear_fallback();
    }
    Ok(())
}

fn strictly_purge_dropbox_promotion_journal_with<
    WriteFallback,
    ReadFallback,
    ClearKeyring,
    ReadKeyring,
    ClearFallback,
>(
    keyring_enabled: bool,
    mut write_fallback: WriteFallback,
    mut read_fallback: ReadFallback,
    mut clear_keyring: ClearKeyring,
    mut read_keyring: ReadKeyring,
    mut clear_fallback: ClearFallback,
) -> Result<(), String>
where
    WriteFallback: FnMut(&str) -> Result<(), String>,
    ReadFallback: FnMut() -> Result<Option<String>, String>,
    ClearKeyring: FnMut() -> Result<(), String>,
    ReadKeyring: FnMut() -> Result<Option<String>, String>,
    ClearFallback: FnMut() -> Result<(), String>,
{
    let tombstone = serialize_dropbox_journal_tombstone()?;
    write_fallback(&tombstone)?;
    let persisted = read_fallback()?.ok_or_else(|| {
        "Dropbox credential promotion tombstone is missing after write".to_string()
    })?;
    if !matches!(
        parse_dropbox_promotion_journal_fallback_record(&persisted)?,
        DropboxPromotionJournalFallbackRecord::Cleared { .. }
    ) {
        return Err(
            "Dropbox credential promotion tombstone failed durable read-back verification"
                .to_string(),
        );
    }

    if keyring_enabled {
        clear_keyring()?;
        match read_keyring() {
            Ok(None) => {}
            Ok(Some(_)) => {
                return Err(
                    "Dropbox credential promotion journal remained in the keyring after deletion"
                        .to_string(),
                )
            }
            Err(_) => {
                return Err(
                    "Dropbox credential promotion keyring deletion could not be verified"
                        .to_string(),
                )
            }
        }
    }
    clear_fallback()?;
    if read_fallback()?.is_some() {
        return Err(
            "Dropbox credential promotion journal fallback failed deletion verification"
                .to_string(),
        );
    }
    if keyring_enabled {
        let recheck = read_keyring();
        if !matches!(recheck, Ok(None)) {
            let restore_result = write_fallback(&tombstone).and_then(|_| {
                let restored = read_fallback()?.ok_or_else(|| {
                    "Dropbox credential promotion tombstone is missing after restoration"
                        .to_string()
                })?;
                if matches!(
                    parse_dropbox_promotion_journal_fallback_record(&restored)?,
                    DropboxPromotionJournalFallbackRecord::Cleared { .. }
                ) {
                    Ok(())
                } else {
                    Err(
                        "Dropbox credential promotion tombstone failed restoration verification"
                            .to_string(),
                    )
                }
            });
            return match restore_result {
                Ok(()) => Err(
                    "Dropbox credential promotion keyring deletion became uncertain after fallback removal; tombstone was restored"
                        .to_string(),
                ),
                Err(error) => Err(format!(
                    "Dropbox credential promotion keyring deletion became uncertain and the tombstone could not be restored: {error}"
                )),
            };
        }
    }
    Ok(())
}

fn write_dropbox_promotion_journal_fallback(
    app: &tauri::AppHandle,
    payload: Option<&str>,
) -> Result<(), String> {
    update_dropbox_credential_state(app, |state| {
        state.promotion_journal = payload.map(str::to_string);
        Ok(())
    })
    .map(|_| ())
}

fn read_dropbox_promotion_journal_fallback(
    app: &tauri::AppHandle,
) -> Result<Option<String>, String> {
    Ok(read_dropbox_credential_state(app)?.promotion_journal)
}

fn clear_dropbox_promotion_journal_fallback_verified(app: &tauri::AppHandle) -> Result<(), String> {
    write_dropbox_promotion_journal_fallback(app, None)?;
    if read_dropbox_promotion_journal_fallback(app)?.is_some() {
        return Err(
            "Dropbox credential promotion journal fallback failed deletion verification"
                .to_string(),
        );
    }
    Ok(())
}

fn clear_dropbox_promotion_journal_keyring(app: &tauri::AppHandle) -> Result<(), String> {
    set_keyring_secret(app, KEYRING_DROPBOX_PROMOTION_JOURNAL, None)
        .map_err(|_| "Failed to delete the Dropbox credential promotion journal".to_string())
}

fn write_dropbox_promotion_journal_keyring_verified(
    app: &tauri::AppHandle,
    payload: &str,
    expected: &DropboxCredentialPromotionJournal,
) -> Result<(), String> {
    set_keyring_secret(
        app,
        KEYRING_DROPBOX_PROMOTION_JOURNAL,
        Some(payload.to_string()),
    )
    .map_err(|_| "Failed to persist the Dropbox credential promotion journal".to_string())?;
    let raw = get_keyring_secret(app, KEYRING_DROPBOX_PROMOTION_JOURNAL)
        .map_err(|_| "Failed to verify the Dropbox credential promotion journal".to_string())?
        .ok_or_else(|| {
            "Dropbox credential promotion journal is missing after keyring write".to_string()
        })?;
    let persisted = match parse_dropbox_promotion_journal_fallback_record(&raw)? {
        DropboxPromotionJournalFallbackRecord::Pending { journal } => journal,
        DropboxPromotionJournalFallbackRecord::PendingKeyring { .. } => {
            return Err(
                "Dropbox credential promotion keyring contains a marker instead of a journal"
                    .to_string(),
            )
        }
        DropboxPromotionJournalFallbackRecord::Cleared { .. } => {
            return Err(
                "Dropbox credential promotion keyring contains a tombstone after journal write"
                    .to_string(),
            )
        }
    };
    if &persisted != expected {
        return Err(
            "Dropbox credential promotion journal failed keyring read-back verification"
                .to_string(),
        );
    }
    Ok(())
}

fn read_dropbox_promotion_journal(
    app: &tauri::AppHandle,
) -> Result<Option<DropboxCredentialPromotionJournal>, String> {
    read_dropbox_promotion_journal_authority_with(
        || {
            Ok(dropbox_recovery_state_is_durably_off(
                &read_native_dropbox_recovery_commit_state(app)?,
            ))
        },
        |payload| write_dropbox_promotion_journal_fallback(app, Some(payload)),
        || read_dropbox_promotion_journal_fallback(app),
        || get_keyring_secret(app, KEYRING_DROPBOX_PROMOTION_JOURNAL),
        || clear_dropbox_promotion_journal_keyring(app),
        || clear_dropbox_promotion_journal_fallback_verified(app),
    )
}

fn write_dropbox_promotion_journal(
    app: &tauri::AppHandle,
    journal: &DropboxCredentialPromotionJournal,
) -> Result<(), String> {
    write_dropbox_promotion_journal_authority_with(
        journal,
        |payload| write_dropbox_promotion_journal_keyring_verified(app, payload, journal),
        |payload| {
            if matches!(
                parse_dropbox_promotion_journal_fallback_record(payload),
                Ok(DropboxPromotionJournalFallbackRecord::Pending { .. })
            ) {
                crate::config::emit_keyring_fallback_warning(app, "Dropbox recovery credentials");
            }
            write_dropbox_promotion_journal_fallback(app, Some(payload))
        },
        || read_dropbox_promotion_journal_fallback(app),
    )
}

fn clear_dropbox_promotion_journal(app: &tauri::AppHandle) -> Result<(), String> {
    logically_clear_dropbox_promotion_journal_with(
        |payload| write_dropbox_promotion_journal_fallback(app, Some(payload)),
        || read_dropbox_promotion_journal_fallback(app),
        || clear_dropbox_promotion_journal_keyring(app),
        || get_keyring_secret(app, KEYRING_DROPBOX_PROMOTION_JOURNAL),
        || clear_dropbox_promotion_journal_fallback_verified(app),
    )
}

fn strictly_purge_dropbox_promotion_journal(app: &tauri::AppHandle) -> Result<(), String> {
    strictly_purge_dropbox_promotion_journal_with(
        !crate::storage::is_portable_mode(),
        |payload| write_dropbox_promotion_journal_fallback(app, Some(payload)),
        || read_dropbox_promotion_journal_fallback(app),
        || clear_dropbox_promotion_journal_keyring(app),
        || get_keyring_secret(app, KEYRING_DROPBOX_PROMOTION_JOURNAL),
        || clear_dropbox_promotion_journal_fallback_verified(app),
    )
}

fn read_native_sync_backend(app: &tauri::AppHandle) -> Result<String, String> {
    let (raw_backend, _) = crate::config::read_sync_backend_publication_state(app)?;
    Ok(raw_backend)
}

fn write_native_sync_backend(app: &tauri::AppHandle, backend: &str) -> Result<(), String> {
    crate::config::set_sync_backend(app.clone(), backend.to_string())?;
    let (raw_backend, state) = crate::config::read_sync_backend_publication_state(app)?;
    if raw_backend.trim() != backend || state.sync_backend_marker.trim() != backend {
        return Err("Native sync backend failed durable read-back verification".to_string());
    }
    Ok(())
}

fn read_native_dropbox_recovery_commit_state(
    app: &tauri::AppHandle,
) -> Result<DropboxRecoveryCommitState, String> {
    let (raw_backend, state) = crate::config::read_sync_backend_publication_state(app)?;
    Ok(DropboxRecoveryCommitState {
        raw_backend,
        backend_marker: state.sync_backend_marker,
        cloud_provider: state.cloud_provider,
        cloud_provider_authority: state.cloud_provider_authority,
    })
}

fn read_native_durably_disabled_sync_backend(app: &tauri::AppHandle) -> Result<String, String> {
    require_durably_disabled_dropbox_backend(read_native_dropbox_recovery_commit_state(app)?)
}

// Callers serialize this with `DropboxStagedCredentialState`. While a journal
// exists, the renderer transaction has already durably selected Dropbox and
// read it back, but has not written `sync_backend = cloud` until after native
// credential promotion succeeds. Therefore `cloud` is the durable commit
// marker: a matching candidate is kept; every other backend restores the
// journaled previous bundle.
fn recover_dropbox_credentials(app: &tauri::AppHandle) -> Result<(), String> {
    // Reconcile a process stop between raw config publication and marker
    // publication before journal inspection. The dedicated marker is the
    // commit authority even when no credential journal exists.
    read_native_dropbox_recovery_commit_state(app)?;
    recover_dropbox_credentials_fail_closed_with_commit_state(
        || read_native_dropbox_recovery_commit_state(app),
        |backend| write_native_sync_backend(app, backend),
        || read_dropbox_tokens_for_recovery(app),
        |journal| resolve_unknown_dropbox_previous_credentials(app, journal),
        |tokens| write_optional_dropbox_tokens(app, tokens),
        || read_dropbox_promotion_journal(app),
        || clear_dropbox_promotion_journal(app),
    )
}

pub(crate) fn recover_dropbox_credentials_on_startup(
    app: &tauri::AppHandle,
) -> Result<DropboxStartupRecoveryOutcome, String> {
    classify_dropbox_startup_recovery_with(recover_dropbox_credentials(app), || {
        read_native_sync_backend(app)
    })
}

fn classify_dropbox_startup_recovery_with<ReadBackend>(
    recovery: Result<(), String>,
    mut read_backend: ReadBackend,
) -> Result<DropboxStartupRecoveryOutcome, String>
where
    ReadBackend: FnMut() -> Result<String, String>,
{
    match recovery {
        Ok(()) => Ok(DropboxStartupRecoveryOutcome::Ready),
        Err(warning) => match read_backend() {
            Ok(backend) if backend.trim() == "off" => {
                Ok(DropboxStartupRecoveryOutcome::SyncDisabled { warning })
            }
            // The abort reason is the only diagnostic a user ever sees (a
            // Windows GUI process shows no stderr), so the underlying errors
            // must ride along — swallowing them cost a full report round-trip
            // in #1064's portable-mode "won't start".
            Ok(backend) => Err(format!(
                "Dropbox credential recovery is uncertain and sync could not be durably disabled (backend: {backend}; recovery: {warning})"
            )),
            Err(read_error) => Err(format!(
                "Dropbox credential recovery is uncertain and the disabled sync state could not be verified (state read: {read_error}; recovery: {warning})"
            )),
        },
    }
}

fn get_valid_dropbox_access_token(
    app: &tauri::AppHandle,
    client_id: &str,
    force_refresh: bool,
) -> Result<String, String> {
    let client_id = normalize_dropbox_client_id(client_id)?;
    let mut tokens =
        read_dropbox_tokens(app)?.ok_or_else(|| "Dropbox is not connected".to_string())?;
    if tokens.client_id != client_id {
        return Err(
            "Dropbox token was issued for a different app key. Reconnect Dropbox.".to_string(),
        );
    }
    if !force_refresh && now_unix_ms() < tokens.expires_at - DROPBOX_TOKEN_REFRESH_SKEW_MS {
        return Ok(tokens.access_token);
    }
    let proxy_url = read_config(app).proxy_url;
    let (access_token, expires_at) =
        refresh_dropbox_token(&client_id, &tokens.refresh_token, proxy_url.as_deref())?;
    tokens.access_token = access_token;
    tokens.expires_at = expires_at;
    write_dropbox_tokens(app, &tokens)?;
    Ok(tokens.access_token)
}

fn get_valid_staged_dropbox_access_token(
    app: &tauri::AppHandle,
    entries: &mut HashMap<String, DropboxStagedCredential>,
    credential_handle: &str,
    client_id: &str,
    force_refresh: bool,
) -> Result<String, String> {
    let normalized_client_id = normalize_dropbox_client_id(client_id)?;
    let proxy_url = read_config(app).proxy_url;
    resolve_staged_dropbox_access_token_with(
        entries,
        credential_handle,
        &normalized_client_id,
        force_refresh,
        now_unix_ms(),
        |client_id, refresh_token| {
            refresh_dropbox_token(client_id, refresh_token, proxy_url.as_deref())
        },
    )
}

fn run_dropbox_oauth(
    app: &tauri::AppHandle,
    client_id: &str,
) -> Result<DropboxTokenBundle, String> {
    let normalized_client_id = normalize_dropbox_client_id(client_id)?;
    let listener =
        TcpListener::bind((DROPBOX_REDIRECT_HOST, DROPBOX_REDIRECT_PORT)).map_err(|error| {
            format!(
                "Failed to start Dropbox OAuth callback listener on {}:{} ({error})",
                DROPBOX_REDIRECT_HOST, DROPBOX_REDIRECT_PORT
            )
        })?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to set Dropbox callback listener mode: {error}"))?;

    let redirect_uri = dropbox_redirect_uri();
    let state = generate_random_urlsafe(24);
    let verifier = generate_dropbox_pkce_verifier();
    let challenge = generate_dropbox_pkce_challenge(&verifier);

    let mut authorize_url = reqwest::Url::parse(DROPBOX_AUTH_ENDPOINT)
        .map_err(|error| format!("Failed to build Dropbox OAuth URL: {error}"))?;
    {
        let mut query = authorize_url.query_pairs_mut();
        query.append_pair("client_id", &normalized_client_id);
        query.append_pair("response_type", "code");
        query.append_pair("redirect_uri", &redirect_uri);
        query.append_pair("code_challenge", &challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("token_access_type", "offline");
        query.append_pair("scope", DROPBOX_SCOPES);
        query.append_pair("state", &state);
    }

    open::that(authorize_url.as_str())
        .map_err(|error| format!("Failed to open Dropbox authorization URL: {error}"))?;

    let code = wait_for_dropbox_auth_code(&listener, &state)?;
    exchange_dropbox_auth_code(
        &normalized_client_id,
        &code,
        &verifier,
        &redirect_uri,
        read_config(app).proxy_url.as_deref(),
    )
}

fn default_sync_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Could not determine home directory for default sync path".to_string())?;
    Ok(home.join("Sync").join(APP_NAME))
}

fn normalize_sync_dir(input: &str) -> PathBuf {
    let path = PathBuf::from(input);
    let legacy_name = format!("{}-sync.json", APP_NAME);
    if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
        if name == DATA_FILE_NAME
            || name == legacy_name
            || name.to_ascii_lowercase().ends_with(".json")
        {
            return path.parent().unwrap_or(&path).to_path_buf();
        }
    }
    path
}

fn validate_sync_dir(path: &PathBuf) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("Sync path cannot be empty".to_string());
    }

    if path.exists() {
        let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Sync path must not be a symlink".to_string());
        }
        if !metadata.is_dir() {
            return Err("Sync path must be a directory".to_string());
        }
    } else {
        fs::create_dir_all(path).map_err(|e| e.to_string())?;
    }

    // Virtual filesystems (WinFSP/rclone mounts) cannot serve the final-path
    // query canonicalize needs (os error 1005) even though the directory
    // works; fall back to the path validated above.
    let Ok(canonical) = fs::canonicalize(path) else {
        return Ok(path.clone());
    };
    let metadata = fs::symlink_metadata(&canonical).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Sync path must not be a symlink".to_string());
    }
    if !metadata.is_dir() {
        return Err("Sync path must be a directory".to_string());
    }

    Ok(canonical)
}

fn strip_windows_verbatim_prefix(raw: &str) -> String {
    const VERBATIM_UNC_PREFIX: &str = "\\\\?\\UNC\\";
    const VERBATIM_PREFIX: &str = "\\\\?\\";

    if let Some(rest) = raw.strip_prefix(VERBATIM_UNC_PREFIX) {
        return format!("\\\\{rest}");
    }
    raw.strip_prefix(VERBATIM_PREFIX).unwrap_or(raw).to_string()
}

fn sync_dir_to_display_string(path: &Path) -> String {
    strip_windows_verbatim_prefix(&path.to_string_lossy())
}

fn resolve_sync_dir(app: &tauri::AppHandle, path: Option<String>) -> Result<PathBuf, String> {
    let candidate = match path {
        Some(raw) => normalize_sync_dir(raw.trim()),
        None => default_sync_dir(app)?,
    };
    validate_sync_dir(&candidate)
}

// A candidate dir reaches the sync-file commands through the activation
// probe BEFORE set_sync_path has granted it to the webview fs scope, and the
// probe's attachment step runs through the fs plugin (scope-checked) — without
// this grant every candidate probe dies on "forbidden path" and a new sync
// folder can never be verified or saved (#1001).
fn resolve_sync_dir_granting_scope(
    app: &tauri::AppHandle,
    path: String,
) -> Result<PathBuf, String> {
    let dir = resolve_sync_dir(app, Some(path))?;
    expand_tauri_fs_scope(app, &dir);
    Ok(dir)
}

fn configured_sync_dir(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let config = read_config(app);
    let Some(sync_path) = config
        .sync_path
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    resolve_sync_dir(app, Some(sync_path.to_string())).map(Some)
}

#[cfg(target_os = "macos")]
fn create_sync_path_bookmark(path: &Path) -> Option<String> {
    let c_path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let raw = unsafe { mindwtr_macos_create_security_bookmark(c_path.as_ptr()) };
    if raw.is_null() {
        log::warn!("Failed to create security-scoped bookmark for {:?}", path);
        return None;
    }
    let result = unsafe { CStr::from_ptr(raw) }.to_string_lossy().to_string();
    unsafe { mindwtr_macos_free_bookmark_string(raw) };
    log::info!("Created security-scoped bookmark for {:?}", path);
    Some(result)
}

#[cfg(target_os = "macos")]
pub(crate) fn resolve_sync_path_bookmark(base64: &str) -> Option<PathBuf> {
    let c_b64 = CString::new(base64).ok()?;
    let raw = unsafe { mindwtr_macos_resolve_security_bookmark(c_b64.as_ptr()) };
    if raw.is_null() {
        log::warn!("Failed to resolve security-scoped bookmark");
        return None;
    }
    let resolved = unsafe { CStr::from_ptr(raw) }.to_string_lossy().to_string();
    unsafe { mindwtr_macos_free_bookmark_string(raw) };
    log::info!("Resolved security-scoped bookmark → {resolved}");
    Some(PathBuf::from(resolved))
}

pub(crate) fn expand_tauri_fs_scope(app: &tauri::AppHandle, dir: &Path) {
    if let Err(error) = app.fs_scope().allow_directory(dir, true) {
        log::warn!("Failed to expand Tauri fs scope for {:?}: {error}", dir);
    } else {
        log::info!("Expanded Tauri fs scope to include {:?}", dir);
    }
}

// Single locked read (configured_sync_dir -> read_config), no write (B2).
#[tauri::command(async)]
pub(crate) fn get_sync_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(configured_sync_dir(&app)?
        .map(|path| sync_dir_to_display_string(&path))
        .unwrap_or_default())
}

// Held across the whole read+mutate+write (B2) — see lock_config_read_modify_write.
#[tauri::command(async)]
pub(crate) fn clear_sync_path(app: tauri::AppHandle) -> Result<bool, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let config_path = get_config_path(&app);
    let mut config = read_config(&app);
    config.sync_path = None;
    config.sync_path_bookmark = None;
    write_config_files(&config_path, &get_secrets_path(&app), &config)?;
    Ok(true)
}

// Off the UI thread: validation creates the folder and round-trips a write test
// on a path the user just picked, which may be a slow mount.
#[tauri::command(async)]
pub(crate) fn set_sync_path(
    app: tauri::AppHandle,
    sync_path: String,
) -> Result<serde_json::Value, String> {
    let config_path = get_config_path(&app);
    let sanitized_path = resolve_sync_dir(&app, Some(sync_path))?;
    probe_sync_dir(&sanitized_path)?;

    // Inform the user when they point sync at an iCloud Drive path.
    let icloud = is_icloud_path(&sanitized_path);
    if icloud {
        log::info!(
            "Sync path is inside iCloud Drive. Mindwtr will detect evicted files \
             and fall back gracefully, but disabling 'Optimize Mac Storage' in \
             iCloud settings is recommended for best reliability."
        );
    }

    #[cfg(target_os = "macos")]
    let bookmark = create_sync_path_bookmark(&sanitized_path);

    // Held across the whole read+mutate+write (B3, same pattern as
    // clear_sync_path) — closes the pre-existing race this command shared
    // with clear_sync_path before B2 fixed that one.
    let _config_guard = lock_config_read_modify_write()?;
    let mut config = read_config(&app);
    config.sync_path = Some(sync_dir_to_display_string(&sanitized_path));
    #[cfg(target_os = "macos")]
    {
        config.sync_path_bookmark = bookmark;
    }
    write_config_files(&config_path, &get_secrets_path(&app), &config)?;

    expand_tauri_fs_scope(&app, &sanitized_path);

    Ok(serde_json::json!({
        "success": true,
        "path": config.sync_path,
        "icloud": icloud
    }))
}

// A non-persisting re-check for the explicit settings action. Keep this off
// ordinary sync cycles; `set_sync_path` performs the only automatic probe.
#[tauri::command(async)]
pub(crate) fn test_sync_path(
    app: tauri::AppHandle,
    sync_path: String,
) -> Result<bool, String> {
    let sanitized_path = resolve_sync_dir_granting_scope(&app, sync_path)?;
    probe_sync_dir(&sanitized_path)?;
    Ok(true)
}

fn normalize_webdav_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path_end = [trimmed.find('?'), trimmed.find('#')]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(trimmed.len());
    let path = trimmed[..path_end].trim_end_matches('/');
    let suffix = &trimmed[path_end..];
    let normalized_path = if path.to_lowercase().ends_with(".json") {
        path.to_string()
    } else {
        format!("{}/{}", path, DATA_FILE_NAME)
    };

    if suffix.is_empty() {
        return normalized_path;
    }

    let hash_index = suffix.find('#');
    let query_part = if suffix.starts_with('?') {
        &suffix[..hash_index.unwrap_or(suffix.len())]
    } else {
        ""
    };
    let hash_part = if let Some(index) = hash_index {
        &suffix[index..]
    } else if suffix.starts_with('#') {
        suffix
    } else {
        ""
    };
    if query_part.is_empty() {
        return format!("{normalized_path}{hash_part}");
    }

    let query = query_part
        .trim_start_matches('?')
        .split('&')
        .filter(|part| {
            let key = part.split_once('=').map(|(key, _)| key).unwrap_or(part);
            key != "_"
        })
        .collect::<Vec<_>>()
        .join("&");
    if query.is_empty() {
        format!("{normalized_path}{hash_part}")
    } else {
        format!("{normalized_path}?{query}{hash_part}")
    }
}

fn normalize_cloud_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_lowercase();
    if lower.ends_with("/v1/data") || lower.ends_with("/data") {
        return trimmed.to_string();
    }
    if let Some(last_segment) = trimmed.rsplit('/').next() {
        if last_segment.len() > 1
            && last_segment.starts_with('v')
            && last_segment[1..]
                .chars()
                .all(|value| value.is_ascii_digit())
        {
            return format!("{trimmed}/data");
        }
    }
    format!("{trimmed}/v1/data")
}

fn is_likely_local_hostname(host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    if host.contains('.') {
        return host.ends_with(".local")
            || host.ends_with(".localdomain")
            || host.ends_with(".home.arpa");
    }
    host.chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '-')
}

fn is_private_http_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(ipv4) => {
                ipv4.is_loopback() || ipv4.is_private() || {
                    let octets = ipv4.octets();
                    octets[0] == 100 && (64..=127).contains(&octets[1])
                }
            }
            std::net::IpAddr::V6(ipv6) => {
                ipv6.is_loopback()
                    || ipv6.is_unique_local()
                    || ipv6.segments()[0] & 0xffc0 == 0xfe80
            }
        };
    }
    is_likely_local_hostname(&host.to_lowercase())
}

fn assert_cloud_url_allowed(url: &str, allow_insecure_http: bool) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Cloud URL is invalid".to_string())?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" => {
            let host = parsed.host_str().unwrap_or_default();
            if allow_insecure_http || is_private_http_host(host) {
                Ok(())
            } else {
                Err("Cloud sync requires HTTPS for public URLs (HTTP allowed for localhost, private IPs, and local hostnames).".to_string())
            }
        }
        _ => Err("Cloud URL must use HTTP or HTTPS.".to_string()),
    }
}

pub(crate) fn assert_webdav_url_allowed(
    url: &str,
    allow_insecure_http: bool,
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "WebDAV URL is invalid".to_string())?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" => {
            let host = parsed.host_str().unwrap_or_default();
            if allow_insecure_http || is_private_http_host(host) {
                Ok(())
            } else {
                Err("WebDAV requires HTTPS for public URLs (HTTP allowed for localhost, private IPs, and local hostnames).".to_string())
            }
        }
        _ => Err("WebDAV URL must use HTTP or HTTPS.".to_string()),
    }
}

/// A configured WebDAV URL may carry `user:pass@` userinfo, and these messages reach the
/// user's error toast. Mirrors core's `sanitizeUrl`: drop the userinfo, keep the rest.
fn redact_url_userinfo(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(mut parsed) if !parsed.username().is_empty() || parsed.password().is_some() => {
            let cleared = parsed
                .set_password(None)
                .and_then(|_| parsed.set_username(""));
            if cleared.is_ok() {
                parsed.to_string()
            } else {
                "[redacted-url]".to_string()
            }
        }
        _ => url.to_string(),
    }
}

fn resolve_webdav_request_url(config: &AppConfigToml) -> Result<String, String> {
    let url = normalize_webdav_url(config.webdav_url.as_deref().unwrap_or_default());
    if url.trim().is_empty() {
        return Err("WebDAV URL not configured".to_string());
    }
    let allow_insecure_http = config.webdav_allow_insecure_http.as_deref() == Some("true");
    assert_webdav_url_allowed(&url, allow_insecure_http)?;
    Ok(url)
}

fn webdav_allows_insecure_http(config: &AppConfigToml) -> bool {
    config.webdav_allow_insecure_http.as_deref() == Some("true")
}

fn parent_webdav_collection_url(raw: &str) -> Option<String> {
    let mut parsed = reqwest::Url::parse(raw).ok()?;
    let trimmed_path = parsed.path().trim_end_matches('/').to_string();
    let last_slash = trimmed_path.rfind('/')?;
    if last_slash == 0 {
        return None;
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    parsed.set_path(&trimmed_path[..last_slash]);
    Some(parsed.to_string().trim_end_matches('/').to_string())
}

fn ensure_webdav_collection_exists_with<F>(url: &str, request_mkcol: &mut F) -> Result<(), String>
where
    F: FnMut(&str) -> Result<reqwest::StatusCode, String>,
{
    let mut status = request_mkcol(url)?;
    if status.is_success() || status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
        return Ok(());
    }

    if status == reqwest::StatusCode::CONFLICT {
        let parent = parent_webdav_collection_url(url)
            .ok_or_else(|| format!("WebDAV MKCOL failed ({status})"))?;
        if parent == url {
            return Err(format!("WebDAV MKCOL failed ({status})"));
        }
        ensure_webdav_collection_exists_with(&parent, request_mkcol)?;
        status = request_mkcol(url)?;
        if status.is_success() || status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Ok(());
        }
    }

    Err(format!("WebDAV MKCOL failed ({status})"))
}

fn ensure_webdav_parent_collections_with<F>(
    file_url: &str,
    request_mkcol: &mut F,
) -> Result<(), String>
where
    F: FnMut(&str) -> Result<reqwest::StatusCode, String>,
{
    let Some(parent) = parent_webdav_collection_url(file_url) else {
        return Ok(());
    };
    ensure_webdav_collection_exists_with(&parent, request_mkcol)
}

fn ensure_webdav_parent_collections_blocking(
    client: &reqwest::blocking::Client,
    file_url: &str,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let mkcol_method =
        reqwest::Method::from_bytes(b"MKCOL").map_err(|e| format!("Invalid WebDAV method: {e}"))?;
    ensure_webdav_parent_collections_with(file_url, &mut |target| {
        let response = client
            .request(mkcol_method.clone(), target)
            .basic_auth(username, Some(password))
            .send()
            .map_err(|e| format_reqwest_send_error("WebDAV request failed", &e))?;
        Ok(response.status())
    })
}

fn is_webdav_mkcol_conflict_error(error: &str) -> bool {
    error.starts_with("WebDAV MKCOL failed (409")
}

// One-line, size-capped server response excerpt for WebDAV error strings. The
// strings travel through the JS bridge into the shared log, where the exact
// method + final URL + status + server body are what distinguish a wrong URL
// from a server-side refusal (#898: Koofr 405s that manual testing could not
// reproduce because the failing request was never logged precisely).
fn webdav_error_body_snippet(body: &str) -> String {
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return String::new();
    }
    let snippet: String = collapsed.chars().take(300).collect();
    format!(": {snippet}")
}

/// `https://host/dav/data.json?x=1` -> `https://host/dav/data.json.enc?x=1`. The `.enc` marker
/// belongs on the path, never after the query — `normalize_webdav_url` preserves a `?`/`#`
/// suffix, so a naive append would corrupt it.
fn encrypted_webdav_url(url: &str) -> String {
    let split = url.find(['?', '#']).unwrap_or(url.len());
    let (path, suffix) = url.split_at(split);
    format!("{}{suffix}", encrypted_artifact_name(path))
}

/// Classifies MWENC1 bytes found where JSON was expected. Ciphertext is never "invalid JSON"
/// to repair (decision #4); an off-state device instead learns the remote is encrypted.
/// A non-empty, non-MWENC1 artifact — a plaintext sync document sitting where a keyed device
/// expects ciphertext. Mirrors core's `isPlaintextSyncArtifact`; an empty or whitespace-only
/// file is evidence of nothing.
fn is_plaintext_sync_artifact(bytes: &[u8]) -> bool {
    matches!(inspect_sync_artifact(bytes), SyncArtifactInspection::Plaintext)
        && bytes.iter().any(|byte| *byte > 0x20)
}

fn webdav_encrypted_discovery(bytes: &[u8]) -> Option<String> {
    match inspect_sync_artifact(bytes) {
        SyncArtifactInspection::Encrypted(header) => Some(encrypted_discovery_marker(&header)),
        SyncArtifactInspection::Unsupported(reason) => Some(terminal_error(reason)),
        SyncArtifactInspection::Plaintext => None,
    }
}

/// The in-band discovery marker `persist_discovery_and_reduce` parses back via
/// `parse_encrypted_discovery` -- the one encoder for every seam that reports ciphertext
/// this device has no (usable) key for.
fn encrypted_discovery_marker(header: &ParsedHeaderFields) -> String {
    format!(
        "{SYNC_ENCRYPTION_REMOTE_ENCRYPTED}:{}:{}:{}:{}",
        bytes_to_hex(&header.salt),
        header.params.m_kib,
        header.params.t,
        header.params.p
    )
}

/// A valid MWENC1 artifact sealed under a DIFFERENT salt than `material` is proof this
/// device's key belongs to another encryption generation (a passphrase set before the first
/// sync while a peer encrypted the remote, or a peer's rotation). Decrypting would only fail
/// as Auth, indistinguishable from a wrong passphrase -- report the discovery marker instead
/// so the command layer downgrades to `remote-encrypted-no-key` and the unlock prompt (which
/// re-derives from the remote's own salt) can heal it. Matching-salt and non-encrypted bytes
/// return None: those cases keep their existing decrypt/terminal behavior.
fn foreign_salt_discovery(bytes: &[u8], material: &SyncKeyMaterial) -> Option<String> {
    match inspect_sync_artifact(bytes) {
        SyncArtifactInspection::Encrypted(header) if header.salt != material.salt => {
            Some(encrypted_discovery_marker(&header))
        }
        _ => None,
    }
}

fn webdav_fetch_optional_bytes(
    client: &reqwest::blocking::Client,
    target: &str,
    username: &str,
    password: &str,
) -> Result<Option<Vec<u8>>, String> {
    let response = client
        .get(target)
        .basic_auth(username, Some(password))
        .send()
        .map_err(|error| format_reqwest_send_error("WebDAV request failed", &error))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "WebDAV GET failed ({status}) at {}{}",
            redact_url_userinfo(target),
            webdav_error_body_snippet(&body)
        ));
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("Invalid WebDAV response: error reading response body: {error}"))?;
    Ok(Some(bytes.to_vec()))
}

fn webdav_get_json_blocking(
    app: &tauri::AppHandle,
    material: Option<&SyncKeyMaterial>,
) -> Result<WebdavSyncReadResult, String> {
    let (config, password) = read_bound_credential(app, CredentialService::Webdav)?;
    let allow_insecure_http = webdav_allows_insecure_http(&config);
    let plain_url = resolve_webdav_request_url(&config)?;
    let url = match material {
        Some(_) => encrypted_webdav_url(&plain_url),
        None => plain_url.clone(),
    };
    let username = config.webdav_username.unwrap_or_default();
    let password = password.ok_or_else(|| "WebDAV password not configured".to_string())?;

    let client = webdav_blocking_http_client(config.proxy_url.as_deref(), allow_insecure_http)?;
    let get = |target: &str| {
        client
            .get(target)
            .basic_auth(&username, Some(&password))
            .send()
            .map_err(|e| format_reqwest_send_error("WebDAV request failed", &e))
    };
    let fetch = |target: &str| {
        webdav_fetch_optional_bytes(&client, target, &username, &password)
    };
    let response = get(&url)?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        // Detection (decision #2): only once the read at this device's own name has already come
        // back missing — a populated remote's steady reads succeed and never issue this probe, so
        // an existing install sees zero extra requests (invariant #1).
        if let Some(discovery) = webdav_absent_document_discovery(&fetch, &plain_url, material)? {
            return Err(discovery);
        }
        return Ok(WebdavSyncReadResult {
            data: Value::Null,
            exists: false,
            strong_etag: None,
        });
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "WebDAV GET failed ({status}) at {}{}",
            redact_url_userinfo(&url),
            webdav_error_body_snippet(&body)
        ));
    }

    let strong_etag = strong_webdav_etag_from_headers(response.headers());
    let body_bytes = response
        .bytes()
        .map_err(|e| format!("Invalid WebDAV response: error reading response body: {e}"))?;

    if let Some(material) = material {
        if let Some(discovery) = foreign_salt_discovery(&body_bytes, material) {
            return Err(discovery);
        }
        let plaintext = decrypt_sync_artifact(&body_bytes, &material.key)
            .map_err(|error| terminal_error(error))?;
        let data = serde_json::from_slice::<Value>(&plaintext).map_err(|e| {
            invalid_webdav_document_error(
                format!("Invalid WebDAV response: error decoding response body: {e}"),
                strong_etag.as_deref(),
            )
        })?;
        return Ok(WebdavSyncReadResult {
            data,
            exists: true,
            strong_etag,
        });
    }

    let body = String::from_utf8_lossy(&body_bytes);
    let normalized_body = body.trim_start_matches('\u{feff}').trim();
    if normalized_body.is_empty() {
        if let Some(discovery) = webdav_absent_document_discovery(&fetch, &plain_url, None)? {
            return Err(discovery);
        }
        return Ok(WebdavSyncReadResult {
            data: Value::Null,
            exists: true,
            strong_etag,
        });
    }
    let data = serde_json::from_str::<Value>(normalized_body).map_err(|e| {
        // Inspect the ORIGINAL bytes, not the lossy UTF-8 text, before conceding "invalid JSON".
        webdav_encrypted_discovery(&body_bytes).unwrap_or_else(|| {
            invalid_webdav_document_error(
                format!("Invalid WebDAV response: error decoding response body: {e}"),
                strong_etag.as_deref(),
            )
        })
    })?;
    Ok(WebdavSyncReadResult {
        data,
        exists: true,
        strong_etag,
    })
}

/// What a document missing at THIS device's own artifact name means, given its posture. Taking
/// the fetch as a bytes-or-nothing closure keeps the decision unit-testable without a server.
fn webdav_absent_document_discovery<Fetch>(
    fetch: &Fetch,
    plain_url: &str,
    material: Option<&SyncKeyMaterial>,
) -> Result<Option<String>, String>
where
    Fetch: Fn(&str) -> Result<Option<Vec<u8>>, String>,
{
    match material {
        // Off-state: ciphertext a peer wrote, which this device needs the passphrase for.
        None => {
            let Some(bytes) = fetch(&encrypted_webdav_url(plain_url))? else {
                return Ok(None);
            };
            if bytes.iter().all(|byte| *byte <= 0x20) {
                return Ok(None);
            }
            Ok(Some(webdav_encrypted_discovery(&bytes).unwrap_or_else(|| {
                terminal_error("Plaintext was found at the encrypted WebDAV artifact name".to_string())
            })))
        }
        // Keyed: the plaintext a peer's disable transition restored. Reporting an empty remote
        // here would merge this device's whole store into a fresh plaintext generation and fork
        // the folder — and this device never follows the remote down to plaintext on its own.
        Some(_) => {
            let Some(bytes) = fetch(plain_url)? else {
                return Ok(None);
            };
            if is_plaintext_sync_artifact(&bytes) {
                return Ok(Some(SYNC_ENCRYPTION_REMOTE_PLAINTEXT.to_string()));
            }
            if bytes.iter().all(|byte| *byte <= 0x20) {
                return Ok(None);
            }
            Ok(Some(terminal_error(
                "Ciphertext or an unsupported artifact was found at the plaintext WebDAV artifact name"
                    .to_string(),
            )))
        }
    }
}

#[tauri::command]
pub(crate) async fn webdav_get_json(app: tauri::AppHandle) -> Result<WebdavSyncReadResult, String> {
    let material = resolve_sync_encryption_material(&app)?;
    let result = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || webdav_get_json_blocking(&app, material.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?;
    persist_discovery_and_reduce(&app, result)
}

fn webdav_put_json_blocking(
    app: &tauri::AppHandle,
    data: &Value,
    material: Option<&SyncKeyMaterial>,
    expected_etag: Option<&str>,
) -> Result<RemoteJsonWriteResult, String> {
    let (config, password) = read_bound_credential(app, CredentialService::Webdav)?;
    let allow_insecure_http = webdav_allows_insecure_http(&config);
    let url = resolve_webdav_request_url(&config)?;
    let url = match material {
        Some(_) => encrypted_webdav_url(&url),
        None => url,
    };
    let username = config.webdav_username.unwrap_or_default();
    let password = password.ok_or_else(|| "WebDAV password not configured".to_string())?;

    let payload = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to encode WebDAV payload: {e}"))?;
    // Encryption wraps the already-serialized document; nothing above this line differs.
    let (payload, content_type): (Vec<u8>, &str) = match material {
        None => (payload.into_bytes(), "application/json"),
        Some(material) => (
            encrypt_sync_artifact(payload.as_bytes(), material)
                .map_err(|error| terminal_error(error))?,
            "application/octet-stream",
        ),
    };
    let client = webdav_blocking_http_client(config.proxy_url.as_deref(), allow_insecure_http)?;
    let (condition_name, condition_value) = webdav_write_condition(expected_etag)?;
    let send_put = || {
        client
            .put(url.clone())
            .basic_auth(&username, Some(&password))
            .header("Content-Type", content_type)
            .header(condition_name.clone(), condition_value.clone())
            .body(payload.clone())
            .send()
            .map_err(|e| format_reqwest_send_error("WebDAV request failed", &e))
    };
    let mut response = send_put()?;

    if response.status() == reqwest::StatusCode::NOT_FOUND
        || response.status() == reqwest::StatusCode::CONFLICT
    {
        if let Err(error) =
            ensure_webdav_parent_collections_blocking(&client, &url, &username, &password)
        {
            if !is_webdav_mkcol_conflict_error(&error) {
                return Err(error);
            }
        }
        response = send_put()?;
    }

    if !response.status().is_success() {
        let status = response.status();
        if status == reqwest::StatusCode::CONFLICT
            || status == reqwest::StatusCode::PRECONDITION_FAILED
        {
            return Err(format!(
                "{WEBDAV_REMOTE_WRITE_CONFLICT}: WebDAV document changed before replacement ({status})"
            ));
        }
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "WebDAV PUT failed ({status}) at {}{}",
            redact_url_userinfo(&url),
            webdav_error_body_snippet(&body)
        ));
    }
    Ok(remote_json_write_result_from_headers(response.headers()))
}

#[tauri::command]
pub(crate) async fn webdav_put_json(
    app: tauri::AppHandle,
    data: Value,
    expected_etag: Option<String>,
) -> Result<RemoteJsonWriteResult, String> {
    let material = resolve_sync_encryption_material(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        webdav_put_json_blocking(&app, &data, material.as_ref(), expected_etag.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn cloud_request_builder(
    client: &reqwest::blocking::Client,
    method: reqwest::Method,
    url: &str,
    token: &str,
) -> reqwest::blocking::RequestBuilder {
    let request = client.request(method, url);
    if token.trim().is_empty() {
        request
    } else {
        request.bearer_auth(token.trim())
    }
}

/// A bare 405 from a cloud sync URL usually means the URL points at
/// something other than a Mindwtr sync server (e.g. the wrong port).
fn wrong_sync_server_hint(status: reqwest::StatusCode) -> &'static str {
    if status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
        " — this URL may not be a Mindwtr sync server (check host and port)"
    } else {
        ""
    }
}

fn parse_cloud_json_body(body: &str) -> Result<Value, String> {
    let normalized = body.trim_start_matches('\u{feff}').trim();
    serde_json::from_str::<Value>(normalized).map_err(|error| {
        let lower = normalized.to_ascii_lowercase();
        if lower.starts_with("<!doctype html") || lower.starts_with("<html") {
            "Cloud GET failed: server returned HTML instead of Mindwtr sync data — check the Self-Hosted URL, host, and port".to_string()
        } else {
            format!("Cloud GET failed: invalid JSON ({error})")
        }
    })
}

fn cloud_get_json_blocking(app: &tauri::AppHandle) -> Result<Value, String> {
    let (config, token) = read_bound_credential(app, CredentialService::Cloud)?;
    let url = normalize_cloud_url(&config.cloud_url.clone().unwrap_or_default());
    if url.trim().is_empty() {
        return Err("Self-hosted URL not configured".to_string());
    }
    let allow_insecure_http = config.cloud_allow_insecure_http.as_deref() == Some("true");
    assert_cloud_url_allowed(&url, allow_insecure_http)?;

    let token = token.unwrap_or_default();
    let client = cloud_blocking_http_client(config.proxy_url.as_deref(), allow_insecure_http)?;
    let response = cloud_request_builder(&client, reqwest::Method::GET, &url, &token)
        .send()
        .map_err(|e| format_reqwest_send_error("Cloud request failed", &e))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Value::Null);
    }
    if !response.status().is_success() {
        return Err(format!(
            "Cloud GET failed ({}): {}{}",
            response.status().as_u16(),
            response.status().canonical_reason().unwrap_or_default(),
            wrong_sync_server_hint(response.status())
        ));
    }

    let body = response
        .text()
        .map_err(|e| format!("Cloud GET failed: error reading response body: {e}"))?;
    parse_cloud_json_body(&body)
}

#[tauri::command]
pub(crate) async fn cloud_get_json(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || cloud_get_json_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn cloud_put_json_blocking(
    app: &tauri::AppHandle,
    data: &Value,
) -> Result<RemoteJsonWriteResult, String> {
    let (config, token) = read_bound_credential(app, CredentialService::Cloud)?;
    let url = normalize_cloud_url(&config.cloud_url.clone().unwrap_or_default());
    if url.trim().is_empty() {
        return Err("Self-hosted URL not configured".to_string());
    }
    let allow_insecure_http = config.cloud_allow_insecure_http.as_deref() == Some("true");
    assert_cloud_url_allowed(&url, allow_insecure_http)?;

    let token = token.unwrap_or_default();
    let payload = serde_json::to_string_pretty(data)
        .map_err(|e| format!("Failed to encode Cloud payload: {e}"))?;
    let client = cloud_blocking_http_client(config.proxy_url.as_deref(), allow_insecure_http)?;
    let response = cloud_request_builder(&client, reqwest::Method::PUT, &url, &token)
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .map_err(|e| format_reqwest_send_error("Cloud request failed", &e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Cloud PUT failed ({}): {}{}",
            response.status().as_u16(),
            response.status().canonical_reason().unwrap_or_default(),
            wrong_sync_server_hint(response.status())
        ));
    }
    let mut result = remote_json_write_result_from_headers(response.headers());
    if let Ok(body) = response.text() {
        apply_cloud_write_response_body(&mut result, &body);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn cloud_put_json(
    app: tauri::AppHandle,
    data: Value,
) -> Result<RemoteJsonWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || cloud_put_json_blocking(&app, &data))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn blocking_http_client_accepts_missing_or_blank_proxy() {
        assert!(blocking_http_client(None).is_ok());
        assert!(blocking_http_client(Some("")).is_ok());
        assert!(blocking_http_client(Some("   ")).is_ok());
    }

    #[test]
    fn blocking_http_client_rejects_invalid_proxy_url() {
        let error = blocking_http_client(Some("not a proxy url")).unwrap_err();
        assert!(
            error.contains("Invalid proxy URL"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn blocking_http_client_routes_requests_through_configured_proxy() {
        use std::io::{Read, Write};

        // Fake proxy: accept one connection, capture the request line, answer.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake proxy");
        let proxy_addr = listener.local_addr().expect("proxy addr");
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept proxied request");
            let mut buffer = [0u8; 1024];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let _ = stream.write_all(
                b"HTTP/1.1 204 No Content\r\nConnection: close\r\ncontent-length: 0\r\n\r\n",
            );
            request
        });

        let client =
            blocking_http_client(Some(&format!("http://{proxy_addr}"))).expect("client with proxy");
        // The target host does not resolve; reaching our listener proves the
        // request went to the proxy instead of connecting directly.
        let _ = client.get("http://mindwtr-proxy-test.invalid/ping").send();

        let request = handle.join().expect("proxy thread");
        assert!(
            request.contains("mindwtr-proxy-test.invalid"),
            "proxy did not receive the request: {request}"
        );
    }

    #[test]
    fn strips_windows_verbatim_prefix_from_sync_path_display() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\mmbtu\Dropbox\Apps\Mindwtr"),
            r"C:\Users\mmbtu\Dropbox\Apps\Mindwtr"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\Mindwtr"),
            r"\\server\share\Mindwtr"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"C:\Users\mmbtu\Dropbox\Apps\Mindwtr"),
            r"C:\Users\mmbtu\Dropbox\Apps\Mindwtr"
        );
    }

    #[test]
    fn wrong_sync_server_hint_appears_only_for_405() {
        assert_eq!(
            wrong_sync_server_hint(reqwest::StatusCode::METHOD_NOT_ALLOWED),
            " — this URL may not be a Mindwtr sync server (check host and port)"
        );
        assert_eq!(wrong_sync_server_hint(reqwest::StatusCode::NOT_FOUND), "");
        assert_eq!(
            wrong_sync_server_hint(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
            ""
        );
        assert_eq!(
            wrong_sync_server_hint(reqwest::StatusCode::UNAUTHORIZED),
            ""
        );
    }

    #[test]
    fn cloud_json_body_explains_html_from_wrong_endpoint() {
        assert_eq!(
            parse_cloud_json_body("<!doctype html><html></html>").unwrap_err(),
            "Cloud GET failed: server returned HTML instead of Mindwtr sync data — check the Self-Hosted URL, host, and port"
        );
    }

    #[test]
    fn normalize_cloud_url_matches_shared_client_shape() {
        assert_eq!(
            normalize_cloud_url("https://example.com"),
            "https://example.com/v1/data"
        );
        assert_eq!(
            normalize_cloud_url("https://example.com/mindwtr/"),
            "https://example.com/mindwtr/v1/data"
        );
        assert_eq!(
            normalize_cloud_url("https://example.com/v2"),
            "https://example.com/v2/data"
        );
        assert_eq!(
            normalize_cloud_url("https://example.com/v1/data"),
            "https://example.com/v1/data"
        );
        assert_eq!(
            normalize_cloud_url("https://example.com/data/"),
            "https://example.com/data"
        );
    }

    #[test]
    fn normalize_webdav_url_strips_cache_busting_query() {
        assert_eq!(
            normalize_webdav_url("https://dav.example.com/mindwtr?_=1782668355219"),
            "https://dav.example.com/mindwtr/data.json"
        );
        assert_eq!(
            normalize_webdav_url("https://dav.example.com/mindwtr/data.json?_=1782668355219"),
            "https://dav.example.com/mindwtr/data.json"
        );
        assert_eq!(
            normalize_webdav_url("https://dav.example.com/mindwtr/#sync"),
            "https://dav.example.com/mindwtr/data.json#sync"
        );
    }

    #[test]
    fn cloud_url_security_allows_https_and_local_http_only_by_default() {
        assert!(assert_cloud_url_allowed("https://example.com/v1/data", false).is_ok());
        assert!(assert_cloud_url_allowed("http://localhost:8787/v1/data", false).is_ok());
        assert!(assert_cloud_url_allowed("http://192.168.1.50:8787/v1/data", false).is_ok());
        assert!(assert_cloud_url_allowed("http://nas.local:8787/v1/data", false).is_ok());
        assert!(assert_cloud_url_allowed("http://example.com/v1/data", false).is_err());
        assert!(assert_cloud_url_allowed("http://example.com/v1/data", true).is_ok());
    }

    #[test]
    fn webdav_url_security_allows_https_and_local_http_only_by_default() {
        assert!(assert_webdav_url_allowed("https://dav.example.com/data.json", false).is_ok());
        assert!(assert_webdav_url_allowed("http://localhost:8080/data.json", false).is_ok());
        assert!(assert_webdav_url_allowed("http://192.168.1.50:8080/data.json", false).is_ok());
        assert!(assert_webdav_url_allowed("http://nas.local:8080/data.json", false).is_ok());
        assert!(assert_webdav_url_allowed("http://dav.example.com/data.json", false).is_err());
        assert!(assert_webdav_url_allowed("http://dav.example.com/data.json", true).is_ok());
        assert!(assert_webdav_url_allowed("ftp://dav.example.com/data.json", true).is_err());
    }

    #[test]
    fn webdav_request_rejects_public_http_from_inconsistent_stored_config() {
        let config = AppConfigToml {
            webdav_url: Some("http://dav.example.com/mindwtr".to_string()),
            webdav_allow_insecure_http: Some("false".to_string()),
            ..AppConfigToml::default()
        };

        let error = resolve_webdav_request_url(&config).unwrap_err();

        assert!(
            error.contains("requires HTTPS"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn webdav_redirect_security_rejects_downgrades_and_unapproved_public_http() {
        let https = reqwest::Url::parse("https://dav.example.com/data.json").unwrap();
        let next_https = reqwest::Url::parse("https://cdn.example.com/data.json").unwrap();
        let next_http = reqwest::Url::parse("http://dav.example.com/data.json").unwrap();
        let initial_http = reqwest::Url::parse("http://nas.local/data.json").unwrap();

        assert!(
            webdav_redirect_security_error(&next_https, std::slice::from_ref(&https), false)
                .is_none()
        );
        assert!(
            webdav_redirect_security_error(&next_http, std::slice::from_ref(&https), true)
                .is_some()
        );
        assert!(webdav_redirect_security_error(
            &next_http,
            std::slice::from_ref(&initial_http),
            false,
        )
        .is_some());
        assert!(webdav_redirect_security_error(&next_http, &[initial_http], true).is_none());
    }

    #[test]
    fn cloud_redirect_security_rejects_downgrades_and_unapproved_public_http() {
        let https = reqwest::Url::parse("https://cloud.example.com/v1/data").unwrap();
        let next_https = reqwest::Url::parse("https://other.example.com/v1/data").unwrap();
        let next_http = reqwest::Url::parse("http://cloud.example.com/v1/data").unwrap();
        let initial_http = reqwest::Url::parse("http://nas.local:8787/v1/data").unwrap();

        assert!(
            cloud_redirect_security_error(&next_https, std::slice::from_ref(&https), false)
                .is_none()
        );
        assert!(
            cloud_redirect_security_error(&next_http, std::slice::from_ref(&https), true).is_some()
        );
        assert!(cloud_redirect_security_error(
            &next_http,
            std::slice::from_ref(&initial_http),
            false,
        )
        .is_some());
        assert!(cloud_redirect_security_error(&next_http, &[initial_http], true).is_none());
    }

    #[test]
    fn dropbox_redirect_security_rejects_downgrades_and_off_host_redirects() {
        let https = reqwest::Url::parse(DROPBOX_TOKEN_ENDPOINT).unwrap();
        let next_same_host = reqwest::Url::parse(DROPBOX_TOKEN_ENDPOINT).unwrap();
        let next_other_host = reqwest::Url::parse("https://evil.example.com/oauth2/token").unwrap();
        let next_http = reqwest::Url::parse("http://api.dropboxapi.com/oauth2/token").unwrap();

        assert!(
            dropbox_redirect_security_error(&next_same_host, std::slice::from_ref(&https))
                .is_none()
        );
        assert!(
            dropbox_redirect_security_error(&next_other_host, std::slice::from_ref(&https))
                .is_some()
        );
        assert!(
            dropbox_redirect_security_error(&next_http, std::slice::from_ref(&https)).is_some()
        );
    }

    #[test]
    fn webdav_error_messages_drop_url_userinfo() {
        assert_eq!(
            redact_url_userinfo("https://alice:hunter2@dav.example.com/mindwtr/data.json"),
            "https://dav.example.com/mindwtr/data.json"
        );
        assert_eq!(
            redact_url_userinfo("https://dav.example.com/mindwtr/data.json"),
            "https://dav.example.com/mindwtr/data.json"
        );
        assert_eq!(redact_url_userinfo("not a url"), "not a url");
    }

    #[test]
    fn parent_webdav_collection_url_strips_query_and_hash() {
        assert_eq!(
            parent_webdav_collection_url(
                "https://example.com/remote.php/dav/files/user/mindwtr/data.json?foo=1#frag"
            ),
            Some("https://example.com/remote.php/dav/files/user/mindwtr".to_string())
        );
    }

    #[test]
    fn ensure_webdav_parent_collections_recurses_on_conflict() {
        let mut calls: Vec<String> = Vec::new();
        let mut attempt = 0usize;

        let result = ensure_webdav_parent_collections_with(
            "https://example.com/remote.php/dav/files/user/mindwtr/nested/data.json",
            &mut |url| {
                calls.push(url.to_string());
                attempt += 1;
                Ok(match attempt {
                    1 => reqwest::StatusCode::CONFLICT,
                    2 => reqwest::StatusCode::CREATED,
                    3 => reqwest::StatusCode::CREATED,
                    _ => panic!("unexpected MKCOL attempt"),
                })
            },
        );

        assert!(result.is_ok());
        assert_eq!(
            calls,
            vec![
                "https://example.com/remote.php/dav/files/user/mindwtr/nested".to_string(),
                "https://example.com/remote.php/dav/files/user/mindwtr".to_string(),
                "https://example.com/remote.php/dav/files/user/mindwtr/nested".to_string(),
            ]
        );
    }

    #[test]
    fn webdav_mkcol_conflict_errors_are_retryable() {
        assert!(is_webdav_mkcol_conflict_error(
            "WebDAV MKCOL failed (409 Conflict)"
        ));
        assert!(!is_webdav_mkcol_conflict_error(
            "WebDAV MKCOL failed (500 Internal Server Error)"
        ));
    }

    #[derive(Debug)]
    struct TestError {
        message: &'static str,
        source: Option<Box<TestError>>,
    }

    impl std::fmt::Display for TestError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.message)
        }
    }

    impl std::error::Error for TestError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.source
                .as_deref()
                .map(|source| source as &(dyn std::error::Error + 'static))
        }
    }

    #[test]
    fn format_error_with_source_chain_includes_nested_causes() {
        let error = TestError {
            message: "error sending request for url (https://mindwtr.private.tld/v1/data)",
            source: Some(Box::new(TestError {
                message: "client error (Connect)",
                source: Some(Box::new(TestError {
                    message: "invalid peer certificate: UnknownIssuer",
                    source: None,
                })),
            })),
        };

        let formatted =
            format_error_with_source_chain("Cloud request failed", &error, &["connect"]);

        assert_eq!(
            formatted,
            "Cloud request failed [connect]: error sending request for url (https://mindwtr.private.tld/v1/data) (caused by: client error (Connect) -> invalid peer certificate: UnknownIssuer)"
        );
    }

    #[test]
    fn sync_backup_replace_failure_restores_previous_backup() {
        let dir = tempfile::tempdir().expect("temp dir");
        let backup = dir.path().join("data.json.bak");
        let backup_tmp = dir.path().join("data.json.bak.tmp");
        let backup_previous = dir.path().join("data.json.bak.previous");
        fs::write(&backup, b"previous").expect("write previous backup");
        fs::write(&backup_tmp, b"replacement").expect("write replacement backup");
        let rename_calls = std::cell::Cell::new(0usize);

        let result = replace_sync_backup_preserving_previous(
            &backup_tmp,
            &backup,
            &backup_previous,
            |path| fs::remove_file(path),
            |from, to| {
                let call = rename_calls.get() + 1;
                rename_calls.set(call);
                if call == 2 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "injected replacement failure",
                    ));
                }
                fs::rename(from, to)
            },
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&backup).expect("restored backup"), b"previous");
        assert!(!backup_previous.exists());
        assert_eq!(
            fs::read(&backup_tmp).expect("replacement remains"),
            b"replacement"
        );
    }

    #[test]
    fn sync_backup_restore_failure_keeps_previous_backup_readable() {
        let dir = tempfile::tempdir().expect("temp dir");
        let backup = dir.path().join("data.json.bak");
        let backup_tmp = dir.path().join("data.json.bak.tmp");
        let backup_previous = dir.path().join("data.json.bak.previous");
        fs::write(&backup, br#"{"tasks":[{"id":"preserved"}]}"#).expect("write previous backup");
        fs::write(&backup_tmp, br#"{"tasks":[{"id":"replacement"}]}"#)
            .expect("write replacement backup");
        let rename_calls = std::cell::Cell::new(0usize);

        let result = replace_sync_backup_preserving_previous(
            &backup_tmp,
            &backup,
            &backup_previous,
            |path| fs::remove_file(path),
            |from, to| {
                let call = rename_calls.get() + 1;
                rename_calls.set(call);
                if call >= 2 {
                    return Err(std::io::Error::other("injected rename failure"));
                }
                fs::rename(from, to)
            },
        );

        assert!(result.is_err());
        assert!(!backup.exists());
        assert!(backup_previous.exists());
        assert_eq!(
            read_sync_backup(&backup, &backup_previous, SyncFileCrypto::Off)
                .expect("backup read must not be a terminal failure")
                .and_then(|value| value.data["tasks"][0]["id"].as_str().map(str::to_owned))
                .as_deref(),
            Some("preserved")
        );
    }

    #[test]
    fn missing_sync_file_recovers_valid_backup_before_seed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let backup = dir.path().join("data.json.bak");
        let seed = dir.path().join("mindwtr-backup-2026-01-01.json");
        fs::write(&backup, br#"{"tasks":[{"id":"backup"}]}"#).expect("write backup");
        fs::write(&seed, br#"{"tasks":[{"id":"seed"}]}"#).expect("write seed");

        let recovered = read_sync_file_versioned_from_dir(dir.path()).expect("recover backup");

        assert_eq!(recovered.data["tasks"][0]["id"], "backup");
        assert_eq!(recovered.source, "backup");
        assert!(recovered.needs_repair);
    }

    #[test]
    fn retained_reader_retries_partial_primary_and_keeps_relaxed_json_parsing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let primary = dir.path().join(DATA_FILE_NAME);
        fs::write(&primary, b"placeholder").expect("seed path for eviction check");
        let mut reads = 0;
        let mut waits = 0;
        let mut read_bytes = |_path: &Path| {
            reads += 1;
            if reads == 1 {
                Ok(b"{\"tasks\":[".to_vec())
            } else {
                Ok(b"\xef\xbb\xbf{\"tasks\":[{\"id\":\"new-primary\"}]} trailing-provider-bytes"
                    .to_vec())
            }
        };
        let mut wait = |_duration: Duration| waits += 1;

        let value = read_sync_candidate_from_retained_root_with(
            &primary,
            5,
            SyncFileCrypto::Off,
            &mut read_bytes,
            &mut wait,
        )
        .expect("second retained read recovers the complete primary");

        assert_eq!(value["tasks"][0]["id"], "new-primary");
        assert_eq!(reads, 2, "primary retries before considering recovery files");
        assert_eq!(waits, 1);

        let source = include_str!("sync.rs");
        let retained_reader = source
            .split_once("fn read_sync_file_from_retained_root_with(")
            .expect("retained reader")
            .1
            .split_once("\n#[derive(Clone, Copy, Debug, Eq, PartialEq)]")
            .expect("end of retained reader")
            .0;
        for required in [
            "root, &primary, 5, crypto",
            "root, path, 2, crypto",
            "root, &legacy, 1, crypto",
            "root, &seed, 1, crypto",
        ] {
            assert!(
                retained_reader.contains(required),
                "retained reader must preserve the old recovery attempt count ({required})"
            );
        }
    }

    #[test]
    fn retained_seed_recovery_prefers_mtime_over_reverse_lexical_name() {
        let dir = tempfile::tempdir().expect("temp dir");
        let lexically_later = dir.path().join("mindwtr-backup-z.json");
        let actually_newer = dir.path().join("mindwtr-backup-a.json");
        fs::write(&lexically_later, br#"{"tasks":[{"id":"older"}]}"#)
            .expect("write older seed");
        fs::write(&actually_newer, br#"{"tasks":[{"id":"newer"}]}"#)
            .expect("write newer seed");
        File::open(&lexically_later)
            .expect("open older seed")
            .set_modified(UNIX_EPOCH + Duration::from_secs(10))
            .expect("set older mtime");
        File::open(&actually_newer)
            .expect("open newer seed")
            .set_modified(UNIX_EPOCH + Duration::from_secs(20))
            .expect("set newer mtime");
        let lock = acquire_sync_lock(dir.path()).expect("sync lock");
        let root = RetainedSyncRoot::new(dir.path(), &lock);

        assert_eq!(retained_seed_backup_files(&root, ".json").unwrap().len(), 2);
        assert_eq!(
            retained_seed_backup_files(&root, ".json").unwrap().len(),
            2,
            "retained directory enumeration must restart from the beginning"
        );

        let recovered = read_sync_file_from_retained_root_with(&root, SyncFileCrypto::Off)
            .expect("recover newest seed");

        assert_eq!(recovered["tasks"][0]["id"], "newer");
        release_sync_lock(&lock);
    }

    #[test]
    #[cfg(unix)]
    fn retained_seed_inventory_follows_the_held_root_not_a_rebound_path() {
        let parent = tempfile::tempdir().expect("temp parent");
        let sync_dir = parent.path().join("sync");
        let displaced = parent.path().join("displaced-sync");
        fs::create_dir(&sync_dir).expect("sync dir");
        fs::write(
            sync_dir.join("mindwtr-backup-retained.json"),
            br#"{"tasks":[{"id":"retained"}]}"#,
        )
        .expect("write retained seed");
        let lock = acquire_sync_lock(&sync_dir).expect("sync lock");
        let root = RetainedSyncRoot::new(&sync_dir, &lock);
        fs::rename(&sync_dir, &displaced).expect("displace held root");
        fs::create_dir(&sync_dir).expect("replacement root");

        let seeds = retained_seed_backup_files(&root, ".json")
            .expect("enumerate through retained root authority");
        assert_eq!(seeds.len(), 1);
        let retained = read_sync_candidate_from_retained_root(
            &root,
            &seeds[0],
            1,
            SyncFileCrypto::Off,
        )
        .expect("read seed through retained root authority");
        assert_eq!(retained["tasks"][0]["id"], "retained");
        assert!(fs::read_dir(&sync_dir)
            .expect("replacement root")
            .next()
            .is_none());
        release_sync_lock(&lock);
    }

    #[test]
    fn recovered_backup_is_repaired_without_rotating_corrupt_primary() {
        let dir = tempfile::tempdir().expect("temp dir");
        let primary = dir.path().join(DATA_FILE_NAME);
        let backup = dir.path().join(format!("{}.bak", DATA_FILE_NAME));
        fs::write(&primary, b"not-json").expect("write corrupt primary");
        fs::write(&backup, br#"{"tasks":[{"id":"recovered"}]}"#).expect("write valid backup");

        let recovered = read_sync_file_versioned_from_dir(dir.path()).expect("recover backup");
        assert!(recovered.needs_repair);
        assert_eq!(recovered.source, "backup");

        write_sync_file_to_dir(
            dir.path(),
            recovered.data.clone(),
            Some(&recovered.fingerprint),
        )
        .expect("repair primary");

        assert_eq!(
            read_sync_candidate(&primary, 1).expect("repaired primary")["tasks"][0]["id"],
            "recovered"
        );
        assert_eq!(
            read_sync_candidate(&backup, 1).expect("known-good backup remains")["tasks"][0]["id"],
            "recovered"
        );
    }

    #[test]
    fn recovered_backup_survives_failure_before_primary_install() {
        let dir = tempfile::tempdir().expect("temp dir");
        let primary = dir.path().join(DATA_FILE_NAME);
        let backup = dir.path().join(format!("{}.bak", DATA_FILE_NAME));
        let tmp = dir.path().join(format!("{}.tmp", DATA_FILE_NAME));
        fs::write(&primary, b"not-json").expect("write corrupt primary");
        fs::write(&backup, br#"{"tasks":[{"id":"preserved"}]}"#).expect("write valid backup");
        fs::create_dir(&tmp).expect("block temp file creation");
        let recovered = read_sync_file_versioned_from_dir(dir.path()).expect("recover backup");

        let result =
            write_sync_file_to_dir(dir.path(), recovered.data, Some(&recovered.fingerprint));

        assert!(result.is_err());
        assert_eq!(
            read_sync_candidate(&backup, 1).expect("known-good backup survives")["tasks"][0]["id"],
            "preserved"
        );
    }

    #[test]
    fn missing_sync_file_recovers_previous_backup_when_current_backup_is_absent() {
        let dir = tempfile::tempdir().expect("temp dir");
        let backup_previous = dir.path().join("data.json.bak.previous");
        fs::write(&backup_previous, br#"{"tasks":[{"id":"previous-backup"}]}"#)
            .expect("write previous backup");

        let value = read_sync_file_from_dir(dir.path()).expect("recover previous backup");

        assert_eq!(value["tasks"][0]["id"], "previous-backup");
    }

    #[test]
    fn parseable_non_object_primary_recovers_previous_primary() {
        let dir = tempfile::tempdir().expect("temp dir");
        let primary = dir.path().join("data.json");
        let previous = dir.path().join("data.json.previous");
        fs::write(&primary, b"null").expect("write wrong-shape primary");
        fs::write(&previous, br#"{"tasks":[{"id":"previous-primary"}]}"#)
            .expect("write previous primary");

        let value = read_sync_file_from_dir(dir.path()).expect("recover previous primary");

        assert_eq!(value["tasks"][0]["id"], "previous-primary");
    }

    #[test]
    fn wrong_typed_sync_surfaces_fall_through_to_next_recovery_candidate() {
        for (surface, wrong_value) in [
            ("tasks", serde_json::json!({})),
            ("projects", serde_json::json!(false)),
            ("sections", serde_json::json!("wrong")),
            ("areas", serde_json::json!(1)),
            ("people", serde_json::json!(null)),
            ("settings", serde_json::json!([])),
        ] {
            let dir = tempfile::tempdir().expect("temp dir");
            let previous = dir.path().join("data.json.previous");
            let backup = dir.path().join("data.json.bak");
            fs::write(
                &previous,
                serde_json::to_vec(&serde_json::json!({ (surface): wrong_value }))
                    .expect("serialize wrong-shape candidate"),
            )
            .expect("write wrong-shape previous primary");
            fs::write(&backup, br#"{"tasks":[{"id":"valid-backup"}]}"#)
                .expect("write valid backup");

            let value = read_sync_file_from_dir(dir.path()).expect("recover valid backup");

            assert_eq!(
                value["tasks"][0]["id"], "valid-backup",
                "surface {surface} should not be normalized into a valid candidate"
            );
        }
    }

    #[test]
    fn malformed_entity_envelopes_fall_through_to_valid_backup() {
        for malformed_tasks in [serde_json::json!([null]), serde_json::json!([{}])] {
            let dir = tempfile::tempdir().expect("temp dir");
            fs::write(
                dir.path().join("data.json.previous"),
                serde_json::to_vec(&serde_json::json!({ "tasks": malformed_tasks }))
                    .expect("serialize malformed candidate"),
            )
            .expect("write malformed previous primary");
            fs::write(
                dir.path().join("data.json.bak"),
                br#"{"tasks":[{"id":"valid-backup"}]}"#,
            )
            .expect("write valid backup");

            let recovered = read_sync_file_from_dir(dir.path()).expect("recover valid backup");

            assert_eq!(recovered["tasks"][0]["id"], "valid-backup");
        }
    }

    #[test]
    fn invalid_legacy_and_newest_seed_fall_through_to_older_seed() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            dir.path().join(format!("{}-sync.json", APP_NAME)),
            br#"{"tasks":[null]}"#,
        )
        .expect("write invalid legacy candidate");
        fs::write(
            dir.path().join("mindwtr-backup-older.json"),
            br#"{"tasks":[{"id":"older-valid"}]}"#,
        )
        .expect("write older valid seed");
        std::thread::sleep(Duration::from_millis(20));
        fs::write(
            dir.path().join("mindwtr-backup-newest.json"),
            br#"{"tasks":[{}]}"#,
        )
        .expect("write newest invalid seed");

        let recovered = read_sync_file_from_dir(dir.path()).expect("recover older valid seed");

        assert_eq!(recovered["tasks"][0]["id"], "older-valid");
    }

    #[test]
    fn corrupt_previous_primary_and_backup_recover_valid_previous_backup() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join("data.json.previous"), b"[]")
            .expect("write wrong-shape previous primary");
        fs::write(dir.path().join("data.json.bak"), br#"{"tasks":"wrong"}"#)
            .expect("write wrong-shape backup");
        fs::write(
            dir.path().join("data.json.bak.previous"),
            br#"{"tasks":[{"id":"previous-backup"}]}"#,
        )
        .expect("write valid previous backup");

        let value = read_sync_file_from_dir(dir.path()).expect("recover previous backup");

        assert_eq!(value["tasks"][0]["id"], "previous-backup");
    }

    #[test]
    fn corrupt_recovery_chain_falls_through_to_seed_backup() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join("data.json.previous"), b"null")
            .expect("write wrong-shape previous primary");
        fs::write(dir.path().join("data.json.bak"), br#"{"areas":false}"#)
            .expect("write wrong-shape backup");
        fs::write(
            dir.path().join("data.json.bak.previous"),
            br#"{"settings":[]}"#,
        )
        .expect("write wrong-shape previous backup");
        fs::write(
            dir.path().join("mindwtr-backup-2026-08-09.json"),
            br#"{"tasks":[{"id":"seed-backup"}]}"#,
        )
        .expect("write valid seed backup");

        let value = read_sync_file_from_dir(dir.path()).expect("recover seed backup");

        assert_eq!(value["tasks"][0]["id"], "seed-backup");
    }

    #[test]
    fn sync_file_replace_failure_restores_previous_primary() {
        let dir = tempfile::tempdir().expect("temp dir");
        let primary = dir.path().join("data.json");
        let replacement = dir.path().join("data.json.tmp");
        let previous = dir.path().join("data.json.previous");
        fs::write(&primary, b"previous primary").expect("write primary");
        fs::write(&replacement, b"replacement").expect("write replacement");
        let rename_calls = std::cell::Cell::new(0usize);

        let result = replace_sync_file_preserving_previous(
            &replacement,
            &primary,
            &previous,
            |path| fs::remove_file(path),
            |from, to| {
                let call = rename_calls.get() + 1;
                rename_calls.set(call);
                if call == 2 {
                    return Err(std::io::Error::other("injected replacement failure"));
                }
                fs::rename(from, to)
            },
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read(&primary).expect("restored primary"),
            b"previous primary"
        );
        assert!(!previous.exists());
        assert_eq!(
            fs::read(&replacement).expect("replacement remains"),
            b"replacement"
        );
    }

    #[test]
    fn sync_file_restore_failure_keeps_previous_primary_readable() {
        let dir = tempfile::tempdir().expect("temp dir");
        let primary = dir.path().join("data.json");
        let replacement = dir.path().join("data.json.tmp");
        let previous = dir.path().join("data.json.previous");
        fs::write(&primary, br#"{"tasks":[{"id":"preserved-primary"}]}"#).expect("write primary");
        fs::write(&replacement, br#"{"tasks":[{"id":"replacement"}]}"#).expect("write replacement");
        let rename_calls = std::cell::Cell::new(0usize);

        let result = replace_sync_file_preserving_previous(
            &replacement,
            &primary,
            &previous,
            |path| fs::remove_file(path),
            |from, to| {
                let call = rename_calls.get() + 1;
                rename_calls.set(call);
                if call >= 2 {
                    return Err(std::io::Error::other("injected rename failure"));
                }
                fs::rename(from, to)
            },
        );

        assert!(result.is_err());
        assert!(!primary.exists());
        assert!(previous.exists());
        let value = read_sync_file_from_dir(dir.path()).expect("read preserved primary");
        assert_eq!(value["tasks"][0]["id"], "preserved-primary");
    }

    #[test]
    fn copied_sync_install_does_not_acknowledge_file_flush_failure() {
        let dir = tempfile::tempdir().expect("temp dir");
        let tmp = dir.path().join("data.json.tmp");
        let target = dir.path().join(DATA_FILE_NAME);
        fs::write(&tmp, b"replacement").expect("write temp");
        fs::write(&target, b"replacement").expect("write copied target");
        let removed = std::cell::Cell::new(false);
        let parent_synced = std::cell::Cell::new(false);

        let result = finish_copied_sync_file_durably(
            &tmp,
            &target,
            |_| Err(std::io::Error::other("injected file flush failure")),
            |_| {
                removed.set(true);
                Ok(())
            },
            |_| {
                parent_synced.set(true);
                Ok(())
            },
        );

        assert!(result.is_err());
        assert!(!removed.get(), "temp remains available after failed flush");
        assert!(!parent_synced.get(), "directory is not acknowledged early");
    }

    #[test]
    fn copied_sync_install_does_not_acknowledge_directory_flush_failure() {
        let dir = tempfile::tempdir().expect("temp dir");
        let tmp = dir.path().join("data.json.tmp");
        let target = dir.path().join(DATA_FILE_NAME);
        fs::write(&tmp, b"replacement").expect("write temp");
        fs::write(&target, b"replacement").expect("write copied target");

        let result = finish_copied_sync_file_durably(
            &tmp,
            &target,
            |_| Ok(()),
            |path| fs::remove_file(path),
            |_| Err(std::io::Error::other("injected directory flush failure")),
        );

        assert!(result.is_err());
        assert!(
            !tmp.exists(),
            "copied temp is removed before directory flush"
        );
    }

    #[test]
    fn stale_file_sync_writer_is_rejected_before_replacing_newer_remote_data() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            dir.path().join(DATA_FILE_NAME),
            br#"{"tasks":[{"id":"initial"}]}"#,
        )
        .expect("seed sync file");
        let first_reader = read_sync_file_versioned_from_dir(dir.path()).expect("first read");
        let second_reader = read_sync_file_versioned_from_dir(dir.path()).expect("second read");
        assert_eq!(first_reader.fingerprint, second_reader.fingerprint);

        write_sync_file_to_dir(
            dir.path(),
            serde_json::json!({ "tasks": [{ "id": "first-writer" }] }),
            Some(&first_reader.fingerprint),
        )
        .expect("first writer wins");

        let stale_result = write_sync_file_to_dir(
            dir.path(),
            serde_json::json!({ "tasks": [{ "id": "stale-second-writer" }] }),
            Some(&second_reader.fingerprint),
        );

        assert_eq!(
            stale_result.expect_err("stale write must conflict"),
            SYNC_FILE_WRITE_CONFLICT
        );
        let remote = read_sync_file_from_dir(dir.path()).expect("read winning remote");
        assert_eq!(remote["tasks"][0]["id"], "first-writer");
    }

    #[test]
    fn dropbox_status_probe_without_evidence_reports_disconnected() {
        assert!(!dropbox_state_has_credential_evidence(
            &DropboxCredentialStateFile::default()
        ));
        assert!(dropbox_state_has_credential_evidence(
            &DropboxCredentialStateFile {
                cloud_provider: "dropbox".to_string(),
                ..DropboxCredentialStateFile::default()
            }
        ));
        assert!(dropbox_state_has_credential_evidence(
            &DropboxCredentialStateFile {
                token_fallback: Some("{}".to_string()),
                ..DropboxCredentialStateFile::default()
            }
        ));

        assert_eq!(
            dropbox_status_probe_outcome(Err("keyring down".to_string()), false),
            Ok(false)
        );
        assert_eq!(
            dropbox_status_probe_outcome(Err("keyring down".to_string()), true),
            Err("keyring down".to_string())
        );
        assert_eq!(dropbox_status_probe_outcome(Ok(true), false), Ok(true));
    }

    #[test]
    fn acquire_sync_lock_rejects_fresh_existing_lock() {
        let dir = tempfile::tempdir().expect("temp dir");
        let first = acquire_sync_lock(dir.path()).expect("first lock");

        let second = acquire_sync_lock(dir.path());

        assert_eq!(
            second.expect_err("fresh lock should block another writer"),
            "Sync lock held by another process"
        );
        release_sync_lock(&first);
    }

    #[cfg(unix)]
    #[test]
    fn replaced_lock_inode_cannot_create_a_second_current_version_owner() {
        let dir = tempfile::tempdir().expect("temp dir");
        let first = acquire_sync_lock(dir.path()).expect("first lock");
        let lock_path = dir.path().join(".mindwtr.lock");
        let displaced = dir.path().join(".mindwtr.lock.displaced");
        fs::rename(&lock_path, &displaced).expect("displace locked inode");
        fs::write(&lock_path, b"replacement").expect("create replacement inode");

        assert!(revalidate_sync_lock(&first, dir.path())
            .expect_err("first owner must detect replacement")
            .contains("lock identity changed"));
        assert_eq!(
            acquire_sync_lock(dir.path()).expect_err(
                "the retained sync-root authority must block the replacement inode owner"
            ),
            "Sync lock held by another process"
        );

        release_sync_lock(&first);
        drop(first);
        let next = acquire_sync_lock(dir.path()).expect("replacement owner after release");
        release_sync_lock(&next);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_lock_file_is_never_an_authority() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("temp dir");
        let peer = dir.path().join("peer-lock");
        fs::write(&peer, b"peer").expect("peer lock");
        symlink(&peer, dir.path().join(".mindwtr.lock")).expect("lock symlink");

        let error = acquire_sync_lock(dir.path()).expect_err("symlink must fail closed");
        assert!(error.contains("Failed to open sync lock"));
        assert_eq!(fs::read(peer).expect("peer remains"), b"peer");
    }

    #[test]
    fn unsupported_flock_is_not_treated_as_contention_or_a_safe_lock() {
        // ENOSYS/EOPNOTSUPP from flock is an unavailable safety capability,
        // not contention and never permission to continue lockless.
        #[cfg(target_os = "linux")]
        {
            let enosys = std::io::Error::from_raw_os_error(38);
            assert!(!is_sync_lock_contention(&enosys));
            assert!(sync_lock_error_message(&enosys)
                .contains("Failed to acquire an exclusive sync lock"));
        }
        let unsupported = std::io::Error::from(std::io::ErrorKind::Unsupported);
        assert!(!is_sync_lock_contention(&unsupported));
        assert!(sync_lock_error_message(&unsupported)
            .contains("Failed to acquire an exclusive sync lock"));
    }

    #[test]
    fn renderer_cycle_lease_blocks_native_transitions_until_release() {
        let dir = tempfile::tempdir().expect("temp dir");
        let state = FileSyncLeaseState::default();
        let token = acquire_file_sync_lease_for_dir(&state, dir.path(), "main")
            .expect("cycle lease");

        // Enable, passphrase change and disable all enter through
        // `acquire_sync_lock`; none may cross the ordinary cycle's final
        // revalidation/persistence boundary while its opaque handle is held.
        for transition in ["enable", "change-passphrase", "disable"] {
            assert_eq!(
                acquire_sync_lock(dir.path())
                    .expect_err(&format!("{transition} must wait for the cycle lease")),
                "Sync lock held by another process"
            );
        }

        release_file_sync_lease_token(&state, &token, "main").expect("release cycle lease");
        let transition = acquire_sync_lock(dir.path()).expect("transition after release");
        release_sync_lock(&transition);
    }

    #[test]
    fn renderer_cycle_lease_allows_its_own_document_write_without_relocking() {
        let dir = tempfile::tempdir().expect("temp dir");
        let state = FileSyncLeaseState::default();
        let token =
            acquire_file_sync_lease_for_dir(&state, dir.path(), "main").expect("cycle lease");
        let leases = state.leases.lock().expect("lease state");
        let held = leases.get(&token).expect("held token");
        assert_eq!(held.sync_dir, normalize_lease_sync_dir(dir.path()));

        write_sync_file_to_dir_with_lease(
            dir.path(),
            serde_json::json!({"tasks": [], "projects": [], "sections": [], "areas": [], "people": [], "settings": {}}),
            None,
            SyncFileCrypto::Off,
            Some(&held._sync_lock),
        )
        .expect("write under existing lease");
        drop(leases);

        release_file_sync_lease_token(&state, &token, "main").expect("release cycle lease");
    }

    #[cfg(unix)]
    #[test]
    fn renderer_cycle_document_write_rejects_lock_replacement_before_finalization() {
        let dir = tempfile::tempdir().expect("temp dir");
        let initial = serde_json::json!({
            "tasks": [{"id": "original"}],
            "projects": [],
            "sections": [],
            "areas": [],
            "people": [],
            "settings": {}
        });
        write_sync_file_to_dir(dir.path(), initial, None).expect("seed document");
        let document_path = dir.path().join("data.json");
        let document_before = fs::read(&document_path).expect("read seeded document");
        let state = FileSyncLeaseState::default();
        let token =
            acquire_file_sync_lease_for_dir(&state, dir.path(), "main").expect("cycle lease");

        let error = with_file_sync_lease(&state, &token, "main", |lease| {
            let sync_dir = lease.sync_dir.clone();
            let lock_path = sync_dir.join(".mindwtr.lock");
            let displaced_lock = sync_dir.join(".mindwtr.lock.displaced");
            let mut replaced = false;
            let mut validate_lease = || {
                if !replaced {
                    fs::rename(&lock_path, &displaced_lock).map_err(|error| error.to_string())?;
                    fs::write(&lock_path, b"peer lock").map_err(|error| error.to_string())?;
                    replaced = true;
                }
                revalidate_sync_lock(&lease._sync_lock, &sync_dir)
            };
            write_sync_file_to_dir_with_lease_and_validation(
                &sync_dir,
                serde_json::json!({
                    "tasks": [{"id": "replacement"}],
                    "projects": [],
                    "sections": [],
                    "areas": [],
                    "people": [],
                    "settings": {}
                }),
                None,
                SyncFileCrypto::Off,
                Some(&lease._sync_lock),
                &mut validate_lease,
            )
        })
        .expect_err("replaced legacy lock must invalidate the renderer write");

        assert!(
            error.contains("lock identity changed"),
            "unexpected error: {error}"
        );
        assert_eq!(
            fs::read(&document_path).expect("read unchanged document"),
            document_before
        );
        release_file_sync_lease_token(&state, &token, "main")
            .expect_err("release must retain the identity-loss result");
    }

    #[cfg(unix)]
    #[test]
    fn self_acquired_document_write_rejects_lock_replacement_before_finalization() {
        let dir = tempfile::tempdir().expect("temp dir");
        let initial = serde_json::json!({
            "tasks": [{"id": "original"}],
            "projects": [],
            "sections": [],
            "areas": [],
            "people": [],
            "settings": {}
        });
        write_sync_file_to_dir(dir.path(), initial, None).expect("seed document");
        let document_path = dir.path().join("data.json");
        let document_before = fs::read(&document_path).expect("read seeded document");
        let lock_path = dir.path().join(".mindwtr.lock");
        let displaced_lock = dir.path().join(".mindwtr.lock.displaced");
        let mut replaced = false;
        let mut replace_before_finalization = || {
            if !replaced {
                fs::rename(&lock_path, &displaced_lock).map_err(|error| error.to_string())?;
                fs::write(&lock_path, b"peer lock").map_err(|error| error.to_string())?;
                replaced = true;
            }
            Ok(())
        };

        let error = write_sync_file_to_dir_with_lease_and_validation(
            dir.path(),
            serde_json::json!({
                "tasks": [{"id": "replacement"}],
                "projects": [],
                "sections": [],
                "areas": [],
                "people": [],
                "settings": {}
            }),
            None,
            SyncFileCrypto::Off,
            None,
            &mut replace_before_finalization,
        )
        .expect_err("replaced legacy lock must invalidate the self-acquired write");

        assert!(
            error.contains("lock identity changed"),
            "unexpected error: {error}"
        );
        assert_eq!(
            fs::read(&document_path).expect("read unchanged document"),
            document_before
        );
    }

    #[cfg(unix)]
    #[test]
    fn renderer_document_write_revalidates_the_lock_at_the_canonical_rename_boundary() {
        let dir = tempfile::tempdir().expect("temp dir");
        let document_path = dir.path().join(DATA_FILE_NAME);
        fs::write(&document_path, br#"{"tasks":[{"id":"original"}]}"#)
            .expect("seed document");
        let document_before = fs::read(&document_path).expect("read seeded document");
        let state = FileSyncLeaseState::default();
        let token =
            acquire_file_sync_lease_for_dir(&state, dir.path(), "main").expect("cycle lease");

        let error = with_file_sync_lease(&state, &token, "main", |lease| {
            let sync_dir = lease.sync_dir.clone();
            let document_tmp = sync_dir.join("data.json.tmp");
            let lock_path = sync_dir.join(".mindwtr.lock");
            let displaced_lock = sync_dir.join(".mindwtr.lock.displaced");
            let mut replaced = false;
            let mut validate_lease = || {
                if !replaced
                    && fs::metadata(&document_tmp)
                        .is_ok_and(|metadata| metadata.len() > 0)
                {
                    fs::rename(&lock_path, &displaced_lock)
                        .map_err(|error| error.to_string())?;
                    fs::write(&lock_path, b"peer lock").map_err(|error| error.to_string())?;
                    replaced = true;
                }
                revalidate_sync_lock(&lease._sync_lock, &sync_dir)
            };
            write_sync_file_to_dir_with_lease_and_validation(
                &sync_dir,
                serde_json::json!({ "tasks": [{ "id": "replacement" }] }),
                None,
                SyncFileCrypto::Off,
                Some(&lease._sync_lock),
                &mut validate_lease,
            )
        })
        .expect_err("lock replacement at the rename boundary must abort");

        assert!(error.contains("lock identity changed"), "unexpected error: {error}");
        assert_eq!(
            fs::read(&document_path).expect("read unchanged document"),
            document_before
        );
        assert!(!dir.path().join("data.json.tmp").exists());
        release_file_sync_lease_token(&state, &token, "main")
            .expect_err("release retains the identity-loss result");
    }

    #[cfg(unix)]
    #[test]
    fn renderer_document_write_revalidates_before_publishing_the_backup() {
        let dir = tempfile::tempdir().expect("temp dir");
        let document_path = dir.path().join(DATA_FILE_NAME);
        fs::write(&document_path, br#"{"tasks":[{"id":"original"}]}"#)
            .expect("seed document");
        let document_before = fs::read(&document_path).expect("read seeded document");
        let state = FileSyncLeaseState::default();
        let token =
            acquire_file_sync_lease_for_dir(&state, dir.path(), "main").expect("cycle lease");

        let error = with_file_sync_lease(&state, &token, "main", |lease| {
            let sync_dir = lease.sync_dir.clone();
            let backup_tmp = sync_dir.join("data.json.bak.tmp");
            let lock_path = sync_dir.join(".mindwtr.lock");
            let displaced_lock = sync_dir.join(".mindwtr.lock.displaced");
            let mut replaced = false;
            let mut validate_lease = || {
                if !replaced && backup_tmp.exists() {
                    fs::rename(&lock_path, &displaced_lock)
                        .map_err(|error| error.to_string())?;
                    fs::write(&lock_path, b"peer lock").map_err(|error| error.to_string())?;
                    replaced = true;
                }
                revalidate_sync_lock(&lease._sync_lock, &sync_dir)
            };
            write_sync_file_to_dir_with_lease_and_validation(
                &sync_dir,
                serde_json::json!({ "tasks": [{ "id": "replacement" }] }),
                None,
                SyncFileCrypto::Off,
                Some(&lease._sync_lock),
                &mut validate_lease,
            )
        })
        .expect_err("lock replacement before backup publication must abort");

        assert!(error.contains("lock identity changed"), "unexpected error: {error}");
        assert_eq!(
            fs::read(&document_path).expect("read unchanged document"),
            document_before
        );
        assert!(!dir.path().join("data.json.bak").exists());
        assert_eq!(
            fs::read(dir.path().join("data.json.bak.tmp")).expect("owned backup temp retained"),
            document_before
        );
        release_file_sync_lease_token(&state, &token, "main")
            .expect_err("release retains the identity-loss result");
    }

    #[cfg(unix)]
    #[test]
    fn renderer_cycle_lease_rejects_a_replaced_sync_root() {
        let temp = tempfile::tempdir().expect("temp dir");
        let sync_root = temp.path().join("sync-root");
        fs::create_dir(&sync_root).expect("sync root");
        let state = FileSyncLeaseState::default();
        let token = acquire_file_sync_lease_for_dir(&state, &sync_root, "main")
            .expect("cycle lease");

        let original_root = temp.path().join("original-sync-root");
        fs::rename(&sync_root, &original_root).expect("move leased root");
        fs::create_dir(&sync_root).expect("replacement root");
        let replacement_marker = sync_root.join("must-remain");
        fs::write(&replacement_marker, b"replacement").expect("replacement marker");

        let error = with_file_sync_lease(&state, &token, "main", |_| Ok(()))
            .expect_err("replaced root must invalidate the held lease");
        assert!(error.contains("root authority changed"), "unexpected error: {error}");
        assert_eq!(
            fs::read(replacement_marker).expect("replacement untouched"),
            b"replacement"
        );

        let release_error = release_file_sync_lease_token(&state, &token, "main")
            .expect_err("release must report the replaced root after dropping the authority");
        assert!(
            release_error.contains("root authority changed"),
            "unexpected release error: {release_error}"
        );
        let replacement = acquire_file_sync_lease_for_dir(&state, &sync_root, "replacement")
            .expect("replacement root must become lockable after the old authority is dropped");
        release_file_sync_lease_token(&state, &replacement, "replacement")
            .expect("release replacement lease");
    }

    #[test]
    fn destroyed_renderer_releases_its_leases_and_allows_reacquisition() {
        let dir = tempfile::tempdir().expect("temp dir");
        let state = FileSyncLeaseState::default();
        let _token =
            acquire_file_sync_lease_for_dir(&state, dir.path(), "main").expect("renderer lease");

        assert_eq!(
            acquire_sync_lock(dir.path()).expect_err("live renderer must retain its lease"),
            "Sync lock held by another process"
        );
        assert_eq!(
            release_file_sync_leases_for_window(&state, "main")
                .expect("destroyed renderer cleanup"),
            1
        );

        let next = acquire_file_sync_lease_for_dir(&state, dir.path(), "replacement")
            .expect("replacement renderer reacquires after teardown");
        release_file_sync_lease_token(&state, &next, "replacement")
            .expect("release replacement lease");
    }

    #[test]
    fn renderer_teardown_only_releases_leases_owned_by_that_window() {
        let first_dir = tempfile::tempdir().expect("first temp dir");
        let second_dir = tempfile::tempdir().expect("second temp dir");
        let state = FileSyncLeaseState::default();
        let _first =
            acquire_file_sync_lease_for_dir(&state, first_dir.path(), "main").expect("main lease");
        let second = acquire_file_sync_lease_for_dir(&state, second_dir.path(), "quick-add")
            .expect("quick-add lease");

        assert_eq!(
            release_file_sync_leases_for_window(&state, "main").expect("main teardown"),
            1
        );
        let first_reacquired = acquire_sync_lock(first_dir.path()).expect("main lock released");
        release_sync_lock(&first_reacquired);
        assert_eq!(
            acquire_sync_lock(second_dir.path())
                .expect_err("unrelated live renderer lease must remain held"),
            "Sync lock held by another process"
        );

        release_file_sync_lease_token(&state, &second, "quick-add")
            .expect("release quick-add lease");
    }

    #[test]
    fn renderer_cannot_release_another_windows_lease() {
        let dir = tempfile::tempdir().expect("temp dir");
        let state = FileSyncLeaseState::default();
        let token =
            acquire_file_sync_lease_for_dir(&state, dir.path(), "main").expect("main lease");

        assert_eq!(
            release_file_sync_lease_token(&state, &token, "quick-add")
                .expect_err("wrong renderer must not release lease"),
            "File Sync lease belongs to a different renderer window"
        );
        assert_eq!(
            acquire_sync_lock(dir.path()).expect_err("lease must remain held"),
            "Sync lock held by another process"
        );

        release_file_sync_lease_token(&state, &token, "main").expect("owner releases lease");
    }

    #[test]
    fn folder_probe_rejects_lock_contention_without_releasing_the_peer_lock() {
        let dir = tempfile::tempdir().expect("temp dir");
        let peer_lock = acquire_sync_lock(dir.path()).expect("peer lock");
        let tmp_file = dir.path().join(".mindwtr-folder-probe-test.tmp");
        let final_file = dir.path().join(".mindwtr-folder-probe-test");

        let error = probe_sync_dir_at(dir.path(), &tmp_file, &final_file)
            .expect_err("folder probe must reject lock contention");

        assert!(error.contains("Sync lock held by another process"));
        assert!(!tmp_file.exists());
        assert!(!final_file.exists());
        assert_eq!(
            acquire_sync_lock(dir.path()).expect_err("peer lock must remain held"),
            "Sync lock held by another process"
        );
        release_sync_lock(&peer_lock);
    }

    #[test]
    fn expired_lease_content_cannot_break_an_active_sync_lock() {
        let dir = tempfile::tempdir().expect("temp dir");
        let lock_path = dir.path().join(".mindwtr.lock");
        fs::write(
            &lock_path,
            br#"{"ownerToken":"clock-skewed-peer","pid":42,"expiresAtMs":0}"#,
        )
        .expect("seed expired advisory lease metadata");
        let first = acquire_sync_lock(dir.path()).expect("first lock");

        assert_eq!(
            acquire_sync_lock(dir.path()).expect_err("active OS lock must reject takeover"),
            "Sync lock held by another process"
        );
        release_sync_lock(&first);

        let next = acquire_sync_lock(dir.path()).expect("released lock can be acquired");
        release_sync_lock(&next);
    }

    #[test]
    fn unlocked_legacy_lock_file_is_reused_without_stale_takeover() {
        let dir = tempfile::tempdir().expect("temp dir");
        let lock_path = dir.path().join(".mindwtr.lock");
        fs::write(&lock_path, b"pid=42 ts=1").expect("write legacy lock metadata");

        let owner = acquire_sync_lock(dir.path()).expect("unlocked legacy file can be reused");
        release_sync_lock(&owner);

        assert!(lock_path.exists(), "stable lock inode must not be unlinked");
        let next = acquire_sync_lock(dir.path()).expect("next owner reuses stable lock inode");
        release_sync_lock(&next);
    }

    #[test]
    #[cfg(unix)]
    fn write_refusing_lock_file_still_grants_the_sync_lock() {
        // A cache-off rclone VFS mount refuses to write-open an existing file
        // (#1001) — it logged an error on every sync while the lock still
        // worked. A read-only mode bit is the local stand-in for that refusal:
        // the lock must be taken through a handle that never asks for write
        // access, on the same stable inode.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp dir");
        let lock_path = dir.path().join(".mindwtr.lock");
        fs::write(&lock_path, b"").expect("seed lock file");
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o444))
            .expect("make the lock file refuse write opens");
        assert!(
            OpenOptions::new().write(true).open(&lock_path).is_err(),
            "test setup must actually refuse write opens (not running as root)"
        );

        let owner = acquire_sync_lock(dir.path()).expect("write-refusing lock file can be locked");

        assert_eq!(
            acquire_sync_lock(dir.path()).expect_err("the lock must still exclude a second writer"),
            "Sync lock held by another process"
        );
        release_sync_lock(&owner);
        assert!(lock_path.exists(), "stable lock inode must not be unlinked");
    }

    #[test]
    fn sync_writes_never_copy_through_a_presizing_copy() {
        // `fs::copy` presizes the destination (`CopyFileExW` on Windows), which
        // a cache-off rclone VFS refuses with a per-sync `Truncate: Can't change
        // size` error (#1001). Nothing on the sync write path may reintroduce
        // it; the refusal is invisible on a local filesystem, so guard the
        // source instead.
        let source = include_str!("sync.rs");
        // Built at runtime: spelling the declaration out as a literal would make
        // this test's own source the first match and guard nothing.
        let declaration = format!("fn {}(", "write_sync_file_to_dir");
        assert_eq!(
            source.matches(&declaration).count(),
            1,
            "write_sync_file_to_dir must be declared exactly once for this check to mean anything"
        );
        let body = source
            .split_once(declaration.as_str())
            .expect("write_sync_file_to_dir")
            .1
            .split_once("\n#[tauri::command")
            .expect("end of write_sync_file_to_dir")
            .0;
        // The slice runs to the next command attribute, so it spans both the thin
        // `write_sync_file_to_dir` delegate and the `_with` function holding the real write.
        // Pin that: a refactor that moves the actual write out of this span would otherwise
        // leave the guard scanning a one-line wrapper and silently guarding nothing.
        let atomic_helper_call = format!("{}(", "atomic_retained_tmp_write_then_rename_with");
        assert!(
            body.contains(&atomic_helper_call),
            "the scanned span must still delegate to the shared atomic writer"
        );
        for (forbidden, reason) in [
            (
                "fs::copy(",
                "must copy sequentially, not through fs::copy, which presizes the destination",
            ),
            (
                "sync_regular_file_for_durability",
                "must flush the handle it wrote, not reopen an existing file for write",
            ),
        ] {
            assert!(
                !body.contains(forbidden),
                "the sync write path {reason} (found {forbidden:?})"
            );
        }
    }

    #[test]
    fn sync_folder_probe_and_real_write_share_one_atomic_write_helper() {
        let source = include_str!("sync.rs");
        let helper_name = ["atomic_retained_tmp_write_then_", "rename_with"].concat();
        let helper_call = format!("{helper_name}(");
        assert_eq!(
            source.matches(&helper_call).count(),
            3,
            "only the real sync writer, folder probe, and focused test shim may call the atomic helper"
        );

        let helper_declaration = format!("fn {helper_name}<");
        let helper_body = source
            .split_once(&helper_declaration)
            .expect("atomic helper")
            .1
            .split_once("\nconst SYNC_FOLDER_PROBE_BYTES")
            .expect("end of atomic helper")
            .0;
        for required in [
            "root.create_new(",
            ".write_all(",
            ".sync_all(",
            ".rename(",
        ] {
            assert!(
                helper_body.contains(required),
                "the shared helper must own the atomic write primitive {required}"
            );
        }
        for forbidden in ["fs::copy(", "sync_regular_file_for_durability"] {
            assert!(
                !helper_body.contains(forbidden),
                "the shared atomic helper must not use {forbidden}"
            );
        }
        assert!(
            !helper_body.contains("root.exists(destination)"),
            "probe publication must rely on one OS no-replace operation, not an exists-then-rename check"
        );

        let retained_rename_body = source
            .split_once("fn retained_root_rename(")
            .expect("retained-root rename implementations")
            .1
            .split_once("\n#[cfg(unix)]\nfn retained_root_remove")
            .expect("end of retained-root rename implementations")
            .0;
        for required in [
            "SYS_renameat2",
            "RENAME_NOREPLACE",
            "renameatx_np",
            "RENAME_EXCL",
            "ReplaceIfExists = replace",
        ] {
            assert!(
                retained_rename_body.contains(required),
                "every supported desktop platform must retain its OS no-replace primitive ({required})"
            );
        }

        let probe_declaration = format!("fn {}<", "probe_sync_dir_at_with");
        let probe_end_declaration = format!("\nfn {}(", "probe_sync_dir");
        let probe_body = source
            .split_once(&probe_declaration)
            .expect("probe_sync_dir_at_with")
            .1
            .split_once(&probe_end_declaration)
            .expect("end of folder probe implementation")
            .0;
        assert!(
            probe_body.contains(&helper_call),
            "the folder probe must use the shared atomic helper"
        );
        assert!(
            probe_body.contains("acquire_sync_lock(sync_dir)"),
            "the folder probe must acquire the real sync lock"
        );
        for forbidden in ["File::create(", ".write_all(", ".sync_all(", "fs::rename("] {
            assert!(
                !probe_body.contains(forbidden),
                "the folder probe must not reimplement the atomic write sequence ({forbidden})"
            );
        }

        let real_write_declaration = format!("fn {}(", "write_sync_file_to_dir_with");
        let real_write_body = source
            .split_once(&real_write_declaration)
            .expect("write_sync_file_to_dir_with")
            .1
            .split_once("\n// Off the UI thread for the same reason as `read_sync_file`")
            .expect("end of write_sync_file_to_dir_with")
            .0;
        assert!(
            real_write_body.contains(&helper_call),
            "the real sync writer must use the shared atomic helper"
        );
    }

    #[test]
    fn sync_folder_probe_stays_off_the_ordinary_sync_cycle() {
        let source = include_str!("sync.rs");
        let probe_call = format!("{}(", "probe_sync_dir");
        assert_eq!(
            source.matches(&probe_call).count(),
            3,
            "the probe may only be declared and called by set_sync_path and test_sync_path"
        );

        let set_path_declaration = format!("pub(crate) fn {}(", "set_sync_path");
        let set_path_body = source
            .split_once(&set_path_declaration)
            .expect("set_sync_path")
            .1
            .split_once("\npub(crate) fn test_sync_path(")
            .expect("end of set_sync_path")
            .0;
        let probe_position = set_path_body
            .find(&probe_call)
            .expect("set_sync_path must run the probe");
        let config_write_position = set_path_body
            .find("write_config_files(")
            .expect("set_sync_path config write");
        assert!(
            probe_position < config_write_position,
            "set_sync_path must finish the probe before saving the path"
        );

        let test_path_body = source
            .split_once("pub(crate) fn test_sync_path(")
            .expect("test_sync_path")
            .1
            .split_once("\nfn normalize_webdav_url(")
            .expect("end of test_sync_path")
            .0;
        assert!(
            test_path_body.contains(&probe_call),
            "the explicit folder test must run the probe"
        );

        let write_command_declaration = format!("pub(crate) fn {}(", "write_sync_file");
        let write_command_body = source
            .split_once(&write_command_declaration)
            .expect("write_sync_file")
            .1
            .split_once("\n// ---------------------------------------------------------------------------")
            .expect("end of write_sync_file")
            .0;
        assert!(
            !write_command_body.contains(&probe_call),
            "ordinary file sync must not run the folder capability probe"
        );
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum ProbeFailureStage {
        Create,
        WriteAndSync,
        Rename,
        ReadBack,
        ReadBackMismatch,
        Delete,
    }

    fn run_folder_probe_with_failure(
        failure: Option<ProbeFailureStage>,
    ) -> (tempfile::TempDir, PathBuf, PathBuf, Result<(), String>) {
        let dir = tempfile::tempdir().expect("temp dir");
        let tmp_file = dir.path().join(".mindwtr-folder-probe-test.tmp");
        let final_file = dir.path().join(".mindwtr-folder-probe-test");
        let final_file_for_remove = final_file.clone();
        let mut delete_failure_injected = false;
        let mut before_stage = |stage: AtomicWriteStage| {
            let should_fail = matches!(
                (stage, failure),
                (AtomicWriteStage::Create, Some(ProbeFailureStage::Create))
                    | (
                        AtomicWriteStage::WriteAndSync,
                        Some(ProbeFailureStage::WriteAndSync)
                    )
                    | (AtomicWriteStage::Rename, Some(ProbeFailureStage::Rename))
            );
            if should_fail {
                Err(format!("injected {stage:?} failure"))
            } else {
                Ok(())
            }
        };
        let mut read_back = |_path: &Path, mut content: Vec<u8>| {
            if failure == Some(ProbeFailureStage::ReadBack) {
                return Err("injected read failure".to_string());
            }
            if failure == Some(ProbeFailureStage::ReadBackMismatch) {
                content.push(b'!');
            }
            Ok(content)
        };
        let mut before_remove = |path: &Path| {
            if failure == Some(ProbeFailureStage::Delete)
                && path == final_file_for_remove
                && path.exists()
                && !delete_failure_injected
            {
                delete_failure_injected = true;
                return Err("injected delete failure".to_string());
            }
            Ok(())
        };

        let result = probe_sync_dir_at_with(
            dir.path(),
            &tmp_file,
            &final_file,
            &mut before_stage,
            &mut read_back,
            &mut before_remove,
        );

        (dir, tmp_file, final_file, result)
    }

    fn assert_folder_probe_failure(stage: ProbeFailureStage, expected: &str) {
        let (_dir, tmp_file, final_file, result) = run_folder_probe_with_failure(Some(stage));
        let error = result.expect_err("probe must report the injected failure");
        assert!(
            error.starts_with(expected),
            "unexpected probe error: {error}"
        );
        assert!(!tmp_file.exists(), "failed probe temp file must be removed");
        assert!(
            !final_file.exists(),
            "failed probe final file must be removed"
        );
    }

    #[test]
    fn sync_folder_probe_round_trips_bytes_and_removes_probe_files() {
        let (_dir, tmp_file, final_file, result) = run_folder_probe_with_failure(None);

        result.expect("probe succeeds");

        assert!(!tmp_file.exists(), "probe temp file must be removed");
        assert!(!final_file.exists(), "probe final file must be removed");
    }

    #[test]
    fn sync_folder_probe_publish_never_replaces_a_final_gap_peer_leaf() {
        let dir = tempfile::tempdir().expect("temp dir");
        let tmp_file = dir.path().join(".mindwtr-folder-probe-race.tmp");
        let final_file = dir.path().join(".mindwtr-folder-probe-race");
        let peer_file = final_file.clone();
        let mut published_peer = false;
        let mut before_stage = |stage: AtomicWriteStage| {
            if stage == AtomicWriteStage::Rename && !published_peer {
                fs::write(&peer_file, b"peer-generation")
                    .map_err(|error| error.to_string())?;
                published_peer = true;
            }
            Ok(())
        };
        let mut read_back = |_path: &Path, bytes: Vec<u8>| Ok(bytes);
        let mut before_remove = |_path: &Path| Ok(());

        let error = probe_sync_dir_at_with(
            dir.path(),
            &tmp_file,
            &final_file,
            &mut before_stage,
            &mut read_back,
            &mut before_remove,
        )
        .expect_err("OS no-replace publication must reject the late peer leaf");

        assert!(error.starts_with("Could not finalize a file in this folder"));
        assert_eq!(
            fs::read(&final_file).expect("peer leaf remains"),
            b"peer-generation"
        );
        assert!(!tmp_file.exists(), "owned temp is cleaned up");
    }

    #[test]
    fn sync_folder_probe_cleanup_quarantines_and_preserves_a_final_gap_peer_leaf() {
        let dir = tempfile::tempdir().expect("temp dir");
        let tmp_file = dir.path().join(".mindwtr-folder-probe-cleanup-race.tmp");
        let final_file = dir.path().join(".mindwtr-folder-probe-cleanup-race");
        let displaced_owned = dir.path().join("owned-probe-generation");
        let mut before_stage = |_stage: AtomicWriteStage| Ok(());
        let mut read_back = |_path: &Path, bytes: Vec<u8>| Ok(bytes);
        let mut swapped = false;
        let mut before_remove = |path: &Path| {
            if !swapped {
                fs::rename(path, &displaced_owned).map_err(|error| error.to_string())?;
                fs::write(path, b"peer-generation").map_err(|error| error.to_string())?;
                swapped = true;
            }
            Ok(())
        };

        let error = probe_sync_dir_at_with(
            dir.path(),
            &tmp_file,
            &final_file,
            &mut before_stage,
            &mut read_back,
            &mut before_remove,
        )
        .expect_err("cleanup must reject the captured peer generation");

        assert!(error.starts_with("Could not remove the test file"));
        assert!(error.contains("captured a replacement leaf"));
        assert_eq!(
            fs::read(&final_file).expect("peer leaf restored"),
            b"peer-generation"
        );
        assert_eq!(
            fs::read(&displaced_owned).expect("owned generation preserved"),
            SYNC_FOLDER_PROBE_BYTES
        );
        assert!(!tmp_file.exists());
        let retained_quarantines = fs::read_dir(dir.path())
            .expect("list directory")
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with(".mindwtr-probe-cleanup-"))
            .collect::<Vec<_>>();
        assert!(
            retained_quarantines.is_empty(),
            "restored peer must not leave a duplicate quarantine: {retained_quarantines:?}"
        );
    }

    fn run_atomic_write_test<BeforeStage>(
        tmp_file: &Path,
        final_file: &Path,
        content: &[u8],
        before_stage: &mut BeforeStage,
        rename_override: Option<&mut dyn FnMut(&Path, &Path) -> Result<(), String>>,
    ) -> Result<OwnedAtomicPublication, AtomicWriteError>
    where
        BeforeStage: FnMut(AtomicWriteStage) -> Result<(), String>,
    {
        atomic_tmp_write_then_rename_with(
            tmp_file,
            final_file,
            content,
            before_stage,
            rename_override,
            false,
        )
    }

    #[test]
    fn atomic_write_refuses_a_preexisting_temp_leaf_without_modifying_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let tmp_file = dir.path().join("probe.tmp");
        let final_file = dir.path().join("probe");
        fs::write(&tmp_file, b"pre-existing").expect("seed temp leaf");
        let mut before_stage = |_stage: AtomicWriteStage| Ok(());

        let error = run_atomic_write_test(
            &tmp_file,
            &final_file,
            b"replacement",
            &mut before_stage,
            None,
        )
        .expect_err("pre-existing temp leaf must be rejected");

        assert_eq!(error.stage, AtomicWriteStage::Create);
        assert_eq!(fs::read(&tmp_file).expect("temp remains"), b"pre-existing");
        assert!(!final_file.exists());
    }

    #[test]
    #[cfg(unix)]
    fn atomic_write_refuses_a_symlink_temp_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("unrelated");
        let tmp_file = dir.path().join("probe.tmp");
        let final_file = dir.path().join("probe");
        fs::write(&target, b"unrelated").expect("seed unrelated file");
        symlink(&target, &tmp_file).expect("seed temp symlink");
        let mut before_stage = |_stage: AtomicWriteStage| Ok(());

        let error = run_atomic_write_test(
            &tmp_file,
            &final_file,
            b"replacement",
            &mut before_stage,
            None,
        )
        .expect_err("symlink temp leaf must be rejected");

        assert_eq!(error.stage, AtomicWriteStage::Create);
        assert_eq!(fs::read(&target).expect("target remains"), b"unrelated");
        assert!(fs::symlink_metadata(&tmp_file)
            .expect("symlink remains")
            .file_type()
            .is_symlink());
    }

    #[test]
    fn atomic_write_leaves_a_name_swap_replacement_untouched() {
        let dir = tempfile::tempdir().expect("temp dir");
        let tmp_file = dir.path().join("probe.tmp");
        let moved_owned_file = dir.path().join("owned-moved-away");
        let unrelated = dir.path().join("unrelated");
        let final_file = dir.path().join("probe");
        fs::write(&unrelated, b"unrelated").expect("seed unrelated file");
        let mut before_stage = |stage: AtomicWriteStage| {
            if stage == AtomicWriteStage::Rename {
                fs::rename(&tmp_file, &moved_owned_file).map_err(|error| error.to_string())?;
                fs::hard_link(&unrelated, &tmp_file).map_err(|error| error.to_string())?;
            }
            Ok(())
        };

        let error = run_atomic_write_test(
            &tmp_file,
            &final_file,
            b"invocation-owned",
            &mut before_stage,
            None,
        )
        .expect_err("name-swapped temp leaf must be rejected");

        assert_eq!(error.stage, AtomicWriteStage::Rename);
        assert_eq!(fs::read(&unrelated).expect("unrelated remains"), b"unrelated");
        assert_eq!(
            fs::read(&tmp_file).expect("replacement hardlink remains"),
            b"unrelated"
        );
        assert_eq!(
            fs::read(&moved_owned_file).expect("owned file remains available"),
            b"invocation-owned"
        );
        assert!(!final_file.exists());
    }

    #[test]
    fn atomic_write_does_not_replace_a_preexisting_probe_destination() {
        let dir = tempfile::tempdir().expect("temp dir");
        let tmp_file = dir.path().join("probe.tmp");
        let final_file = dir.path().join("probe");
        fs::write(&final_file, b"pre-existing").expect("seed destination");
        let mut before_stage = |_stage: AtomicWriteStage| Ok(());

        let error = run_atomic_write_test(
            &tmp_file,
            &final_file,
            b"replacement",
            &mut before_stage,
            None,
        )
        .expect_err("probe destination must be create-new");

        assert_eq!(error.stage, AtomicWriteStage::Rename);
        assert_eq!(fs::read(&final_file).expect("destination remains"), b"pre-existing");
        assert!(!tmp_file.exists(), "owned temp is cleaned up");
    }

    #[test]
    fn atomic_write_retains_only_its_owned_temp_for_a_rename_fallback() {
        let dir = tempfile::tempdir().expect("temp dir");
        let tmp_file = dir.path().join("probe.tmp");
        let final_file = dir.path().join("probe");
        let mut before_stage = |_stage: AtomicWriteStage| Ok(());
        let mut reject_rename = |_from: &Path, _to: &Path| Err("rename refused".to_string());

        let mut error = run_atomic_write_test(
            &tmp_file,
            &final_file,
            b"fallback bytes",
            &mut before_stage,
            Some(&mut reject_rename),
        )
        .expect_err("rename failure must retain the exact temp for fallback");
        let publication = error
            .owned_temp
            .take()
            .expect("rename failure retains invocation-owned temp");

        publication.verify_at(&tmp_file).expect("temp identity remains exact");
        assert_eq!(fs::read(&tmp_file).expect("read temp"), b"fallback bytes");
        drop(publication);
        assert!(!tmp_file.exists(), "dropping the owner cleans only its temp");
    }

    #[test]
    fn atomic_publication_drop_leaves_a_replacement_leaf_untouched() {
        let dir = tempfile::tempdir().expect("temp dir");
        let tmp_file = dir.path().join("probe.tmp");
        let final_file = dir.path().join("probe");
        let moved_owned_file = dir.path().join("owned-moved-away");
        let unrelated = dir.path().join("unrelated");
        fs::write(&unrelated, b"unrelated").expect("seed unrelated file");
        let mut before_stage = |_stage: AtomicWriteStage| Ok(());
        let publication = run_atomic_write_test(
            &tmp_file,
            &final_file,
            b"invocation-owned",
            &mut before_stage,
            None,
        )
        .expect("publish owned leaf");

        let mut swap_before_remove = |path: &Path| {
            fs::rename(path, &moved_owned_file).map_err(|error| error.to_string())?;
            fs::hard_link(&unrelated, path).map_err(|error| error.to_string())
        };
        let error = publication
            .remove_with(&final_file, &mut swap_before_remove)
            .expect_err("cleanup must revalidate after the injected name swap");
        assert!(error.contains("replaced"));
        drop(publication);

        assert_eq!(fs::read(&final_file).expect("replacement remains"), b"unrelated");
        assert_eq!(
            fs::read(&moved_owned_file).expect("owned node remains available"),
            b"invocation-owned"
        );
    }

    #[test]
    #[cfg(unix)]
    fn sync_folder_probe_rejects_a_replaced_root_before_publication() {
        let parent = tempfile::tempdir().expect("temp parent");
        let sync_dir = parent.path().join("sync");
        let displaced_dir = parent.path().join("displaced-sync");
        fs::create_dir(&sync_dir).expect("create sync root");
        let tmp_file = sync_dir.join(".mindwtr-folder-probe-root-swap.tmp");
        let final_file = sync_dir.join(".mindwtr-folder-probe-root-swap");
        let replacement_final_file = final_file.clone();
        let mut swapped = false;
        let mut before_stage = |stage: AtomicWriteStage| {
            if stage == AtomicWriteStage::Rename && !swapped {
                fs::rename(&sync_dir, &displaced_dir).map_err(|error| error.to_string())?;
                fs::create_dir(&sync_dir).map_err(|error| error.to_string())?;
                fs::write(&replacement_final_file, b"replacement-owned")
                    .map_err(|error| error.to_string())?;
                swapped = true;
            }
            Ok(())
        };
        let mut read_back = |_path: &Path, bytes: Vec<u8>| Ok(bytes);
        let mut before_remove = |_path: &Path| Ok(());

        let error = probe_sync_dir_at_with(
            &sync_dir,
            &tmp_file,
            &final_file,
            &mut before_stage,
            &mut read_back,
            &mut before_remove,
        )
        .expect_err("root replacement must abort the probe");

        assert!(error.starts_with("Could not finalize a file in this folder"));
        assert!(error.contains("root authority changed"));
        assert_eq!(
            fs::read(&replacement_final_file).expect("replacement leaf remains"),
            b"replacement-owned"
        );
        assert!(
            !displaced_dir
                .join(".mindwtr-folder-probe-root-swap.tmp")
                .exists(),
            "cleanup must remove only the temp identity through the retained root"
        );
    }

    #[test]
    #[cfg(unix)]
    fn retained_document_publication_never_follows_a_rebound_root_name() {
        let parent = tempfile::tempdir().expect("temp parent");
        let sync_dir = parent.path().join("sync");
        let displaced_dir = parent.path().join("displaced-sync");
        fs::create_dir(&sync_dir).expect("create sync root");
        let tmp_file = sync_dir.join("data.json.tmp");
        let final_file = sync_dir.join(DATA_FILE_NAME);
        let lock = acquire_sync_lock(&sync_dir).expect("acquire retained authority");
        let root = RetainedSyncRoot::new(&sync_dir, &lock);
        let mut swapped = false;
        let mut before_stage = |stage: AtomicWriteStage| {
            if stage == AtomicWriteStage::Rename && !swapped {
                fs::rename(&sync_dir, &displaced_dir).map_err(|error| error.to_string())?;
                fs::create_dir(&sync_dir).map_err(|error| error.to_string())?;
                fs::write(sync_dir.join(DATA_FILE_NAME), b"replacement-root")
                    .map_err(|error| error.to_string())?;
                swapped = true;
            }
            Ok(())
        };

        let mut publication = atomic_retained_tmp_write_then_rename_with(
            &root,
            &tmp_file,
            &final_file,
            b"retained-root",
            &mut before_stage,
            None,
            false,
        )
        .expect("publish through retained root");

        assert_eq!(
            fs::read(sync_dir.join(DATA_FILE_NAME)).expect("replacement document"),
            b"replacement-root"
        );
        assert_eq!(
            fs::read(displaced_dir.join(DATA_FILE_NAME)).expect("retained-root document"),
            b"retained-root"
        );
        assert!(
            revalidate_sync_lock(&lock, &sync_dir)
                .expect_err("caller finalization must reject rebound root")
                .contains("root authority changed")
        );
        publication.keep();
        release_sync_lock(&lock);
    }

    #[test]
    fn retained_error_cleanup_quarantines_before_deciding_ownership() {
        let dir = tempfile::tempdir().expect("temp dir");
        let owned = dir.path().join("data.json.tmp");
        let displaced_owned = dir.path().join("owned-stage-preserved");
        fs::write(&owned, b"owned-stage").expect("seed owned stage");
        let lock = acquire_sync_lock(dir.path()).expect("acquire retained authority");
        let root = RetainedSyncRoot::new(dir.path(), &lock);
        let identity = root.identity(&owned).expect("capture owned identity");
        let mut swapped = false;
        let mut swap_before_quarantine = |path: &Path| {
            fs::rename(path, &displaced_owned).map_err(|error| error.to_string())?;
            fs::write(path, b"peer-stage").map_err(|error| error.to_string())?;
            swapped = true;
            Ok(())
        };

        let error = quarantine_and_remove_retained_identity_with(
            &root,
            &owned,
            identity,
            &mut swap_before_quarantine,
        )
        .expect_err("replacement must be preserved rather than removed");

        assert!(swapped);
        assert!(error.contains("captured a replacement leaf"));
        assert_eq!(fs::read(&owned).expect("peer restored"), b"peer-stage");
        assert_eq!(
            fs::read(&displaced_owned).expect("owned stage preserved"),
            b"owned-stage"
        );
        release_sync_lock(&lock);
    }

    #[test]
    #[cfg(unix)]
    fn link_fallback_never_unlinks_a_replaced_destination_on_source_failure() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("stage");
        let destination = dir.path().join("canonical");
        let linked_generation = dir.path().join("linked-generation-preserved");
        let peer = dir.path().join("peer");
        fs::write(&source, b"owned-generation").expect("seed source");
        fs::write(&peer, b"peer-generation").expect("seed peer");

        let error = retained_root_link_then_unlink_no_replace_with(
            || fs::hard_link(&source, &destination),
            || {
                fs::rename(&destination, &linked_generation)?;
                fs::rename(&peer, &destination)?;
                Err(std::io::Error::other("injected source retirement failure"))
            },
        )
        .expect_err("failed source retirement must report the retained duplicate");

        assert!(error.to_string().contains("both names were preserved"));
        assert_eq!(
            fs::read(&destination).expect("peer destination remains"),
            b"peer-generation"
        );
        assert_eq!(
            fs::read(&linked_generation).expect("linked generation remains"),
            b"owned-generation"
        );
        assert_eq!(
            fs::read(&source).expect("source remains"),
            b"owned-generation"
        );
    }

    #[test]
    fn retained_windows_replacement_validates_around_every_mutation() {
        let dir = tempfile::tempdir().expect("temp dir");
        let replacement = dir.path().join("data.json.tmp");
        let target = dir.path().join(DATA_FILE_NAME);
        let previous = dir.path().join("data.json.previous");
        fs::write(&replacement, b"new-generation").expect("seed replacement");
        fs::write(&target, b"old-generation").expect("seed target");
        let lock = acquire_sync_lock(dir.path()).expect("acquire retained authority");
        let root = RetainedSyncRoot::new(dir.path(), &lock);
        let mut validations = 0;

        replace_retained_file_preserving_previous(
            &root,
            &replacement,
            &target,
            &previous,
            "sync file",
            &mut || {
                validations += 1;
                Ok(())
            },
        )
        .expect("replace through retained root");

        assert_eq!(validations, 6, "each of three mutations is fenced twice");
        assert_eq!(fs::read(&target).expect("installed target"), b"new-generation");
        assert!(!replacement.exists());
        assert!(!previous.exists());
        release_sync_lock(&lock);
    }

    #[test]
    fn retained_windows_replacement_stops_before_install_when_lease_changes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let replacement = dir.path().join("data.json.tmp");
        let target = dir.path().join(DATA_FILE_NAME);
        let previous = dir.path().join("data.json.previous");
        fs::write(&replacement, b"new-generation").expect("seed replacement");
        fs::write(&target, b"old-generation").expect("seed target");
        let lock = acquire_sync_lock(dir.path()).expect("acquire retained authority");
        let root = RetainedSyncRoot::new(dir.path(), &lock);
        let mut validations = 0;

        let error = replace_retained_file_preserving_previous(
            &root,
            &replacement,
            &target,
            &previous,
            "sync file",
            &mut || {
                validations += 1;
                if validations == 3 {
                    Err("injected lock identity loss".to_string())
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("identity loss before install must stop the sequence");

        assert!(error.contains("identity loss"));
        assert!(!target.exists(), "no later install mutation may run");
        assert_eq!(
            fs::read(&previous).expect("old generation remains recoverable"),
            b"old-generation"
        );
        assert_eq!(
            fs::read(&replacement).expect("new generation remains staged"),
            b"new-generation"
        );
        release_sync_lock(&lock);
    }

    #[test]
    fn sync_folder_probe_reports_create_failure_and_cleans_up() {
        assert_folder_probe_failure(
            ProbeFailureStage::Create,
            "Could not create a file in this folder",
        );
    }

    #[test]
    fn sync_folder_probe_reports_write_and_sync_failure_and_cleans_up() {
        assert_folder_probe_failure(
            ProbeFailureStage::WriteAndSync,
            "Could not finish writing a file in this folder",
        );
    }

    #[test]
    fn sync_folder_probe_reports_rename_failure_and_cleans_up() {
        assert_folder_probe_failure(
            ProbeFailureStage::Rename,
            "Could not finalize a file in this folder",
        );
    }

    #[test]
    fn sync_folder_probe_reports_read_back_failure_and_cleans_up() {
        assert_folder_probe_failure(
            ProbeFailureStage::ReadBack,
            "Wrote a file but could not read it back",
        );
    }

    #[test]
    fn sync_folder_probe_verifies_read_back_bytes_and_cleans_up() {
        assert_folder_probe_failure(
            ProbeFailureStage::ReadBackMismatch,
            "Wrote a file but could not read it back",
        );
    }

    #[test]
    fn sync_folder_probe_reports_delete_failure_and_retries_cleanup() {
        assert_folder_probe_failure(
            ProbeFailureStage::Delete,
            "Could not remove the test file",
        );
    }

    // ---------------------------------------------------------------
    // Sync encryption at the file-sync seam (#1056 phase 2)
    // ---------------------------------------------------------------

    fn test_material(seed: u8) -> SyncKeyMaterial {
        // The seam never derives; it is handed material. Skipping Argon2 here keeps these
        // tests fast without weakening what they check.
        SyncKeyMaterial {
            key: [seed; KEY_LEN],
            salt: [seed; SALT_LEN],
            params: SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
        }
    }

    fn seal(bytes: &[u8], material: &SyncKeyMaterial) -> Vec<u8> {
        encrypt_sync_artifact(bytes, material).expect("seal")
    }

    #[test]
    fn encryption_off_writes_exactly_what_it_wrote_before_the_feature() {
        // Backward-compat invariant #1: an install that never opts in must be byte-for-byte
        // and path-for-path unchanged.
        let dir = tempfile::tempdir().expect("temp dir");
        let data = serde_json::json!({ "tasks": [{ "id": "a" }] });
        write_sync_file_to_dir(dir.path(), data.clone(), None).expect("write");

        let written = fs::read_to_string(dir.path().join(DATA_FILE_NAME)).expect("read");
        assert_eq!(written, serde_json::to_string_pretty(&data).expect("pretty"));
        assert!(!dir.path().join("data.json.enc").exists());
        assert!(!dir.path().join("data.json.tmp").exists());
    }

    #[test]
    fn encrypted_documents_round_trip_through_the_enc_names() {
        let dir = tempfile::tempdir().expect("temp dir");
        let material = test_material(1);
        let crypto = SyncFileCrypto::Enabled(&material);
        let data = serde_json::json!({ "tasks": [{ "id": "encrypted" }] });

        write_sync_file_to_dir_with(dir.path(), data.clone(), None, crypto).expect("write");

        assert!(dir.path().join("data.json.enc").exists());
        assert!(!dir.path().join(DATA_FILE_NAME).exists());
        let raw = fs::read(dir.path().join("data.json.enc")).expect("read raw");
        assert!(matches!(inspect_sync_artifact(&raw), SyncArtifactInspection::Encrypted(_)));
        assert!(!raw.starts_with(b"{"), "the document on disk must not be readable JSON");

        let read = read_sync_file_versioned_from_dir_with(dir.path(), crypto).expect("read");
        assert_eq!(read.data["tasks"][0]["id"], "encrypted");
        assert_eq!(read.source, "primary");
        // Fingerprints stay plaintext-domain, so they match a plaintext write of the same doc.
        assert_eq!(read.fingerprint, sync_document_fingerprint(&read.data).expect("fingerprint"));
    }

    #[test]
    fn a_second_encrypted_write_rotates_the_backup_under_the_enc_names() {
        let dir = tempfile::tempdir().expect("temp dir");
        let material = test_material(1);
        let crypto = SyncFileCrypto::Enabled(&material);

        write_sync_file_to_dir_with(dir.path(), serde_json::json!({ "tasks": [{ "id": "one" }] }), None, crypto)
            .expect("first write");
        write_sync_file_to_dir_with(dir.path(), serde_json::json!({ "tasks": [{ "id": "two" }] }), None, crypto)
            .expect("second write");

        assert!(dir.path().join("data.json.enc.bak").exists());
        let backup = read_sync_candidate_with(&dir.path().join("data.json.enc.bak"), 1, crypto)
            .expect("backup decrypts");
        assert_eq!(backup["tasks"][0]["id"], "one");
    }

    #[test]
    fn a_wrong_key_read_is_terminal_and_never_degrades_into_recovery() {
        // The data-loss guardrail (decision #4): ciphertext this device cannot open may be a
        // peer's perfectly good newer generation. It must stop the run, not walk the recovery
        // chain and certainly not "repair" anything.
        let dir = tempfile::tempdir().expect("temp dir");
        let real = test_material(1);
        let primary = seal(br#"{"tasks":[{"id":"remote"}]}"#, &real);
        let backup = seal(br#"{"tasks":[{"id":"older-remote"}]}"#, &real);
        fs::write(dir.path().join("data.json.enc"), &primary).expect("write primary");
        fs::write(dir.path().join("data.json.enc.bak"), &backup).expect("write backup");

        // Same salt, different key: a genuine wrong passphrase within the same encryption
        // generation (the different-salt shape is a discovery instead — see the next test).
        let wrong = SyncKeyMaterial { key: [2; KEY_LEN], salt: real.salt, params: real.params };
        let error = read_sync_file_versioned_from_dir_with(
            dir.path(),
            SyncFileCrypto::Enabled(&wrong),
        )
        .expect_err("a wrong key must fail the read");

        assert!(is_terminal_error(&error), "expected a terminal error, got: {error}");
        // Nothing moved, nothing was rewritten, nothing fell back to the backup's contents.
        assert_eq!(fs::read(dir.path().join("data.json.enc")).expect("primary"), primary);
        assert_eq!(fs::read(dir.path().join("data.json.enc.bak")).expect("backup"), backup);
        assert!(!dir.path().join("data.json.enc.previous").exists());
    }

    #[test]
    fn a_foreign_salt_read_reports_a_no_key_discovery_instead_of_a_dead_end() {
        // A passphrase set before the first sync (or a peer's rotation) leaves this device
        // holding a key derived from a different salt than the artifacts on disk. That is
        // provably a generation mismatch, not corruption: the read must surface the discovery
        // marker so the command layer downgrades to remote-encrypted-no-key and the unlock
        // prompt can re-derive the key from the artifact's own salt.
        let dir = tempfile::tempdir().expect("temp dir");
        let remote = test_material(1);
        let primary = seal(br#"{"tasks":[{"id":"remote"}]}"#, &remote);
        fs::write(dir.path().join("data.json.enc"), &primary).expect("write primary");

        let foreign = test_material(2);
        let error = read_sync_file_versioned_from_dir_with(
            dir.path(),
            SyncFileCrypto::Enabled(&foreign),
        )
        .expect_err("a foreign-salt read must fail the read");

        let (salt, params) = parse_encrypted_discovery(&error).expect("a discovery marker");
        assert_eq!(salt, remote.salt);
        assert_eq!(params, remote.params);
        // Nothing moved, nothing was rewritten.
        assert_eq!(fs::read(dir.path().join("data.json.enc")).expect("primary"), primary);
    }

    #[test]
    fn tampered_ciphertext_is_terminal_rather_than_invalid_json_to_repair() {
        let dir = tempfile::tempdir().expect("temp dir");
        let material = test_material(1);
        let mut sealed = seal(br#"{"tasks":[{"id":"remote"}]}"#, &material);
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;
        fs::write(dir.path().join("data.json.enc"), &sealed).expect("write");

        let error = read_sync_file_versioned_from_dir_with(
            dir.path(),
            SyncFileCrypto::Enabled(&material),
        )
        .expect_err("tampered bytes must fail the read");

        assert!(is_terminal_error(&error), "expected a terminal error, got: {error}");
        assert_eq!(fs::read(dir.path().join("data.json.enc")).expect("primary"), sealed);
    }

    #[test]
    fn a_wrong_key_write_refuses_and_leaves_the_backup_unrotated() {
        let dir = tempfile::tempdir().expect("temp dir");
        let real = test_material(1);
        let primary = seal(br#"{"tasks":[{"id":"remote"}]}"#, &real);
        let backup = seal(br#"{"tasks":[{"id":"older-remote"}]}"#, &real);
        fs::write(dir.path().join("data.json.enc"), &primary).expect("write primary");
        fs::write(dir.path().join("data.json.enc.bak"), &backup).expect("write backup");

        let wrong = test_material(2);
        let error = write_sync_file_to_dir_with(
            dir.path(),
            serde_json::json!({ "tasks": [{ "id": "local" }] }),
            None,
            SyncFileCrypto::Enabled(&wrong),
        )
        .expect_err("a wrong key must refuse the write");

        assert!(is_terminal_error(&error), "expected a terminal error, got: {error}");
        assert_eq!(fs::read(dir.path().join("data.json.enc")).expect("primary"), primary);
        assert_eq!(fs::read(dir.path().join("data.json.enc.bak")).expect("backup"), backup);
        assert!(!dir.path().join("data.json.enc.bak.previous").exists());
        assert!(!dir.path().join("data.json.enc.tmp").exists());
    }

    #[test]
    fn an_off_state_device_detects_an_encrypted_remote_only_after_the_plaintext_chain_is_empty() {
        let dir = tempfile::tempdir().expect("temp dir");
        let material = test_material(1);
        fs::write(
            dir.path().join("data.json.enc"),
            seal(br#"{"tasks":[{"id":"remote"}]}"#, &material),
        )
        .expect("write");

        let error = read_sync_file_versioned_from_dir(dir.path())
            .expect_err("ciphertext with no key must not read as an empty remote");
        let (salt, params) = parse_encrypted_discovery(&error).expect("discovery payload");
        assert_eq!(salt, material.salt);
        assert_eq!(params, material.params);
    }

    #[test]
    fn an_off_state_device_does_not_treat_an_unreadable_encrypted_document_as_empty() {
        let dir = tempfile::tempdir().expect("temp dir");
        let encrypted = dir.path().join(encrypted_artifact_name(DATA_FILE_NAME));
        fs::create_dir(&encrypted).expect("unreadable encrypted artifact");

        let error = read_sync_file_versioned_from_dir(dir.path())
            .expect_err("an unreadable encrypted generation must fail closed");

        assert!(
            error.contains("Failed to inspect sync artifact"),
            "unexpected error: {error}"
        );
        assert!(
            encrypted.is_dir(),
            "the peer generation must remain untouched"
        );
        assert!(
            !dir.path().join(DATA_FILE_NAME).exists(),
            "the read must not create a plaintext fork"
        );
    }

    #[test]
    fn an_enabled_device_does_not_treat_an_unreadable_plaintext_document_as_empty() {
        let dir = tempfile::tempdir().expect("temp dir");
        let plaintext = dir.path().join(DATA_FILE_NAME);
        fs::create_dir(&plaintext).expect("unreadable plaintext artifact");
        let material = test_material(1);

        let error = read_sync_file_versioned_from_dir_with(
            dir.path(),
            SyncFileCrypto::Enabled(&material),
        )
        .expect_err("an unreadable plaintext generation must fail closed");

        assert!(
            error.contains("Failed to inspect sync artifact"),
            "unexpected error: {error}"
        );
        assert!(
            plaintext.is_dir(),
            "the peer generation must remain untouched"
        );
        assert!(
            !dir.path().join(encrypted_artifact_name(DATA_FILE_NAME)).exists(),
            "the read must not create an encrypted fork"
        );
    }

    #[test]
    fn an_off_state_device_with_a_populated_plaintext_remote_ignores_the_enc_name_entirely() {
        // Invariant #1: an existing install must not change behavior, and must not start
        // reading (or erroring on) a name it never looked at before.
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join(DATA_FILE_NAME), br#"{"tasks":[{"id":"plain"}]}"#).expect("plain");
        fs::write(dir.path().join("data.json.enc"), b"not even a valid container").expect("enc");

        let read = read_sync_file_versioned_from_dir(dir.path()).expect("plaintext read");
        assert_eq!(read.data["tasks"][0]["id"], "plain");
        assert_eq!(read.source, "primary");
    }

    #[test]
    fn plain_named_ciphertext_is_classified_before_the_recovery_chain_can_rotate_it() {
        // A peer that wrote MWENC1 under the plain name (or a partially-migrated folder) must
        // not look like "corrupt JSON, fall through to the backup and repair".
        let dir = tempfile::tempdir().expect("temp dir");
        let material = test_material(1);
        fs::write(
            dir.path().join(DATA_FILE_NAME),
            seal(br#"{"tasks":[{"id":"remote"}]}"#, &material),
        )
        .expect("write");
        fs::write(dir.path().join("data.json.bak"), br#"{"tasks":[{"id":"stale"}]}"#).expect("bak");

        let error = read_sync_file_versioned_from_dir(dir.path())
            .expect_err("plain-named ciphertext must not resolve to the stale backup");
        assert!(parse_encrypted_discovery(&error).is_some(), "unexpected error: {error}");
    }

    fn seed_transition_folder(dir: &Path) {
        fs::write(dir.join(DATA_FILE_NAME), br#"{"tasks":[{"id":"current"}]}"#).expect("data");
        fs::write(dir.join("data.json.bak"), br#"{"tasks":[{"id":"backup"}]}"#).expect("bak");
        fs::write(dir.join("mindwtr-backup-2026-01-01.json"), br#"{"tasks":[{"id":"seed"}]}"#)
            .expect("seed");
        fs::create_dir_all(dir.join("attachments")).expect("attachments dir");
        fs::write(dir.join("attachments").join("a1.png"), b"\x89PNG attachment bytes").expect("att");
    }

    #[test]
    fn enable_converts_every_artifact_and_removes_plaintext_only_after_verification() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());

        let material = enable_sync_encryption_in_dir(dir.path(), "correct horse battery").expect("enable");

        for name in ["data.json.enc", "data.json.enc.bak", "mindwtr-backup-2026-01-01.json.enc"] {
            let bytes = fs::read(dir.path().join(name)).unwrap_or_else(|_| panic!("missing {name}"));
            assert!(
                matches!(inspect_sync_artifact(&bytes), SyncArtifactInspection::Encrypted(_)),
                "{name} must be an MWENC1 container"
            );
            decrypt_sync_artifact(&bytes, &material.key).unwrap_or_else(|_| panic!("{name} must decrypt"));
        }
        for name in [DATA_FILE_NAME, "data.json.bak", "mindwtr-backup-2026-01-01.json"] {
            assert!(!dir.path().join(name).exists(), "{name} must be gone once its .enc verified");
        }
        // Attachments keep their exact name — cloudKey is identity-keyed and immutable.
        let attachment = fs::read(dir.path().join("attachments").join("a1.png")).expect("attachment");
        assert_eq!(
            decrypt_sync_artifact(&attachment, &material.key).expect("attachment decrypts"),
            b"\x89PNG attachment bytes"
        );

        // The folder now reads back through the encrypted seam.
        let read = read_sync_file_versioned_from_dir_with(
            dir.path(),
            SyncFileCrypto::Enabled(&material),
        )
        .expect("read after enable");
        assert_eq!(read.data["tasks"][0]["id"], "current");
    }

    #[test]
    fn an_interrupted_enable_leaves_both_generations_and_a_re_run_completes() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let first = enable_sync_encryption_in_dir(dir.path(), "correct horse battery").expect("enable");

        // Simulate a crash between "wrote the .enc" and "removed the plaintext": both
        // generations present. A re-run must reuse the salt already committed to the folder
        // (deriving a second key under a fresh salt would orphan everything the first run
        // wrote) and converge.
        fs::write(dir.path().join("data.json.bak"), br#"{"tasks":[{"id":"backup"}]}"#).expect("bak");
        let second = enable_sync_encryption_in_dir(dir.path(), "correct horse battery").expect("re-run");

        assert_eq!(second.salt, first.salt);
        assert_eq!(second.key, first.key);
        assert!(!dir.path().join("data.json.bak").exists());
        assert!(dir.path().join("data.json.enc.bak").exists());
    }

    #[test]
    fn an_interrupted_enable_authenticates_the_resumed_key_before_mutating_attachments() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        enable_sync_encryption_in_dir(dir.path(), "correct horse battery").expect("enable");

        let attachment = dir.path().join("attachments").join("a1.png");
        fs::write(&attachment, b"plaintext left by an interrupted enable")
            .expect("restore attachment");
        let document = fs::read(dir.path().join("data.json.enc")).expect("encrypted document");
        let attachment_before = fs::read(&attachment).expect("attachment before");

        let error = enable_sync_encryption_in_dir(dir.path(), "typo passphrase")
            .expect_err("wrong passphrase must fail before transition mutation");

        assert!(
            is_terminal_error(&error),
            "expected a terminal error, got: {error}"
        );
        assert_eq!(
            fs::read(dir.path().join("data.json.enc")).expect("document after"),
            document
        );
        assert_eq!(
            fs::read(&attachment).expect("attachment after"),
            attachment_before
        );
    }

    #[test]
    fn enable_binds_the_attachment_inventory_to_the_snapshotted_document_generation() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let peer_document = br#"{"tasks":[{"id":"peer","attachments":[{"cloudKey":"attachments/a2.png"}]}]}"#;
        let peer_attachment = b"peer attachment generation";

        let error = enable_sync_encryption_in_dir_with(
            dir.path(),
            "correct horse battery",
            || {
                fs::write(dir.path().join(DATA_FILE_NAME), peer_document)
                    .map_err(|error| error.to_string())?;
                fs::write(dir.path().join("attachments").join("a2.png"), peer_attachment)
                    .map_err(|error| error.to_string())?;
                Ok(())
            },
            |_, _, _| Ok(()),
        )
        .expect_err("a peer document generation must fail its fixed-generation CAS");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert_eq!(
            fs::read(dir.path().join(DATA_FILE_NAME)).expect("peer document"),
            peer_document
        );
        assert_eq!(
            fs::read(dir.path().join("attachments").join("a2.png")).expect("peer attachment"),
            peer_attachment
        );
        assert!(!dir.path().join("data.json.enc").exists());

        let resumed = enable_sync_encryption_in_dir(dir.path(), "correct horse battery")
            .expect("retry includes the peer attachment generation");
        let migrated = fs::read(dir.path().join("attachments").join("a2.png"))
            .expect("migrated peer attachment");
        assert_eq!(
            decrypt_sync_artifact(&migrated, &resumed.key).expect("peer attachment decrypts"),
            peer_attachment
        );
    }

    #[test]
    fn an_enable_interrupted_during_the_attachment_phase_resumes_under_the_same_key() {
        // Enable seals attachments before it writes any `.enc` document, so this crash window
        // leaves sealed attachments and no encrypted document to recover the salt from. If the
        // re-run drew a fresh salt, those attachments — skipped next pass as "already
        // encrypted" — would never open again.
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let material = enable_sync_encryption_in_dir(dir.path(), "correct horse battery").expect("enable");

        // Rewind to exactly that window: documents back to plaintext, attachment still sealed.
        for (enc, plain, contents) in [
            ("data.json.enc", DATA_FILE_NAME, br#"{"tasks":[{"id":"current"}]}"#.as_slice()),
            ("data.json.enc.bak", "data.json.bak", br#"{"tasks":[{"id":"backup"}]}"#.as_slice()),
            (
                "mindwtr-backup-2026-01-01.json.enc",
                "mindwtr-backup-2026-01-01.json",
                br#"{"tasks":[{"id":"seed"}]}"#.as_slice(),
            ),
        ] {
            fs::remove_file(dir.path().join(enc)).expect("remove enc");
            fs::write(dir.path().join(plain), contents).expect("restore plaintext");
        }
        assert!(matches!(
            inspect_sync_artifact(&fs::read(dir.path().join("attachments").join("a1.png")).expect("att")),
            SyncArtifactInspection::Encrypted(_)
        ));

        let resumed = enable_sync_encryption_in_dir(dir.path(), "correct horse battery").expect("resume");

        assert_eq!(resumed.salt, material.salt, "the resumed run must reuse the committed salt");
        let attachment = fs::read(dir.path().join("attachments").join("a1.png")).expect("attachment");
        assert_eq!(
            decrypt_sync_artifact(&attachment, &resumed.key).expect("attachment still opens"),
            b"\x89PNG attachment bytes"
        );
    }

    #[test]
    fn enable_converges_every_authenticated_generation_under_the_selected_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let selected = enable_sync_encryption_in_dir(dir.path(), "shared passphrase")
            .expect("initial enable");
        let abandoned = derive_sync_key_material(
            "shared passphrase",
            [41; SALT_LEN],
            SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
        )
        .expect("abandoned material");
        let attachment_path = dir.path().join(SYNC_ATTACHMENTS_DIR_NAME).join("a1.png");
        fs::write(
            &attachment_path,
            encrypt_sync_artifact(b"abandoned attachment generation", &abandoned)
                .expect("seal abandoned attachment"),
        )
        .expect("write abandoned attachment");

        let resumed = enable_sync_encryption_in_dir(dir.path(), "shared passphrase")
            .expect("resume mixed-salt enable");

        assert_eq!(resumed.salt, selected.salt, "the base document remains authoritative");
        assert_eq!(
            decrypt_sync_artifact(
                &fs::read(&attachment_path).expect("converged attachment"),
                &resumed.key,
            )
            .expect("attachment must converge under the selected key"),
            b"abandoned attachment generation",
        );
    }

    #[test]
    fn enable_preflights_every_encrypted_generation_before_starting_its_journal() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        enable_sync_encryption_in_dir(dir.path(), "shared passphrase").expect("initial enable");
        let foreign = derive_sync_key_material(
            "other passphrase",
            [43; SALT_LEN],
            SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
        )
        .expect("foreign material");
        let attachment_path = dir.path().join(SYNC_ATTACHMENTS_DIR_NAME).join("a1.png");
        let foreign_attachment = encrypt_sync_artifact(b"foreign attachment", &foreign)
            .expect("seal foreign attachment");
        fs::write(&attachment_path, &foreign_attachment).expect("write foreign attachment");
        let document_path = dir.path().join(encrypted_artifact_name(DATA_FILE_NAME));
        let document_before = fs::read(&document_path).expect("document before");
        let journal_started = Cell::new(false);

        let error = enable_sync_encryption_in_dir_with(
            dir.path(),
            "shared passphrase",
            || {
                journal_started.set(true);
                Ok(())
            },
            |_, _, _| Ok(()),
        )
        .expect_err("a foreign generation must fail the read-only preflight");

        assert!(is_terminal_error(&error), "unexpected error: {error}");
        assert!(!journal_started.get(), "preflight failure must not start the journal");
        assert_eq!(fs::read(&document_path).expect("document after"), document_before);
        assert_eq!(fs::read(&attachment_path).expect("attachment after"), foreign_attachment);
    }

    #[test]
    fn disable_restores_plaintext_and_change_passphrase_rewraps_everything() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let first = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");

        let next = change_sync_encryption_passphrase_in_dir(dir.path(), &first.key, "second pass")
            .expect("rotate");
        assert_ne!(next.salt, first.salt, "rotation must draw a fresh salt");
        let rotated = fs::read(dir.path().join("data.json.enc")).expect("rotated document");
        assert!(decrypt_sync_artifact(&rotated, &first.key).is_err(), "the old key must be dead");
        decrypt_sync_artifact(&rotated, &next.key).expect("the new key must open it");

        disable_sync_encryption_in_dir(dir.path(), &next.key).expect("disable");
        assert!(!dir.path().join("data.json.enc").exists());
        assert_eq!(
            read_sync_file_versioned_from_dir(dir.path()).expect("plaintext read").data["tasks"][0]["id"],
            "current"
        );
        assert_eq!(
            fs::read(dir.path().join("attachments").join("a1.png")).expect("attachment"),
            b"\x89PNG attachment bytes"
        );
    }

    #[test]
    fn transitions_round_trip_legitimate_scratch_like_attachment_names() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let attachments = dir.path().join(SYNC_ATTACHMENTS_DIR_NAME);
        let cases = [
            ("attachment.tmp", b"temporary extension".as_slice()),
            ("attachment.previous", b"previous extension".as_slice()),
            ("attachment.lock", b"lock extension".as_slice()),
            (".dot-name", b"dot-prefixed attachment".as_slice()),
        ];
        for (name, bytes) in cases {
            fs::write(attachments.join(name), bytes).expect("write attachment");
        }

        let first = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        for (name, bytes) in cases {
            let sealed = fs::read(attachments.join(name)).expect("sealed attachment");
            assert_eq!(
                decrypt_sync_artifact(&sealed, &first.key).expect("open enabled attachment"),
                bytes,
                "{name} must be included in enable",
            );
        }

        let next = change_sync_encryption_passphrase_in_dir(dir.path(), &first.key, "second pass")
            .expect("rotate");
        for (name, bytes) in cases {
            let rotated = fs::read(attachments.join(name)).expect("rotated attachment");
            assert!(
                decrypt_sync_artifact(&rotated, &first.key).is_err(),
                "{name} must not remain under the old key",
            );
            assert_eq!(
                decrypt_sync_artifact(&rotated, &next.key).expect("open rotated attachment"),
                bytes,
                "{name} must be included in rotation",
            );
        }

        disable_sync_encryption_in_dir(dir.path(), &next.key).expect("disable");
        for (name, bytes) in cases {
            assert_eq!(
                fs::read(attachments.join(name)).expect("plaintext attachment"),
                bytes,
                "{name} must be included in disable",
            );
        }
    }

    #[test]
    fn transition_quarantine_cas_preserves_racing_replace_remove_and_create_generations() {
        fn replace_quarantine_bytes(target: &Path, bytes: &[u8]) -> Result<(), String> {
            let parent = target.parent().ok_or_else(|| "target has no parent".to_string())?;
            let leaf = target.file_name().ok_or_else(|| "target has no leaf".to_string())?;
            for entry in fs::read_dir(parent).map_err(|error| error.to_string())? {
                let path = entry.map_err(|error| error.to_string())?.path();
                if !path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(SYNC_ENCRYPTION_QUARANTINE_DIR_PREFIX))
                {
                    continue;
                }
                let candidate = path.join(leaf);
                if candidate.exists() {
                    return fs::write(candidate, bytes).map_err(|error| error.to_string());
                }
            }
            Err("quarantine generation was not found".to_string())
        }

        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("artifact.bin");
        fs::write(&target, b"initial").expect("initial");
        let expected = transition_artifact_fingerprint(b"initial");
        let mut replace_injected = false;
        let error = write_and_verify_with_hook(
            &target,
            b"ours",
            Some(&expected),
            |_| Ok(()),
            |point, path| {
                if point == TransitionMutationPoint::BeforeQuarantine && !replace_injected {
                    replace_injected = true;
                    fs::write(path, b"peer").map_err(|error| error.to_string())?;
                }
                Ok(())
            },
        )
        .expect_err("stale replacement must conflict");
        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert_eq!(fs::read(&target).expect("peer bytes"), b"peer");
        assert!(
            dir.path().read_dir().expect("list").any(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .contains("encryption-stage")
            }),
            "the proposed generation remains staged after conflict"
        );

        let remove_target = dir.path().join("remove.bin");
        fs::write(&remove_target, b"remove-initial").expect("remove initial");
        let remove_expected = transition_artifact_fingerprint(b"remove-initial");
        let mut remove_injected = false;
        let error = remove_transition_artifact_if_version_with_hook(
            &remove_target,
            &remove_expected,
            &remove_target,
            |point, path| {
                if point == TransitionMutationPoint::BeforeQuarantine && !remove_injected {
                    remove_injected = true;
                    fs::write(path, b"remove-peer").map_err(|error| error.to_string())?;
                }
                Ok(())
            },
        )
        .expect_err("stale remove must conflict");
        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert_eq!(
            fs::read(&remove_target).expect("peer remove bytes"),
            b"remove-peer"
        );

        let recreated_target = dir.path().join("remove-recreated.bin");
        fs::write(&recreated_target, b"remove-current").expect("remove current");
        let recreated_expected = transition_artifact_fingerprint(b"remove-current");
        let mut recreate_injected = false;
        let error = remove_transition_artifact_if_version_with_hook(
            &recreated_target,
            &recreated_expected,
            &recreated_target,
            |point, path| {
                if point == TransitionMutationPoint::BeforeRemoveCommit && !recreate_injected {
                    recreate_injected = true;
                    fs::write(path, b"peer-recreated").map_err(|error| error.to_string())?;
                }
                Ok(())
            },
        )
        .expect_err("a peer generation recreated before remove commit must conflict");
        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert_eq!(
            fs::read(&recreated_target).expect("peer recreated bytes"),
            b"peer-recreated"
        );
        assert!(
            dir.path().read_dir().expect("list").any(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .contains("encryption-quarantine")
            }),
            "the displaced generation remains quarantined after a remove race"
        );

        let create_target = dir.path().join("new.bin");
        let mut create_injected = false;
        let error = write_and_verify_with_hook(
            &create_target,
            b"ours",
            None,
            |_| Ok(()),
            |point, path| {
                if point == TransitionMutationPoint::BeforeInstall && !create_injected {
                    create_injected = true;
                    fs::write(path, b"peer-created").map_err(|error| error.to_string())?;
                }
                Ok(())
            },
        )
        .expect_err("create-new must not replace");
        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert_eq!(
            fs::read(&create_target).expect("peer-created bytes"),
            b"peer-created"
        );

        let install_target = dir.path().join("install-race.bin");
        fs::write(&install_target, b"install-initial").expect("install initial");
        let install_expected = transition_artifact_fingerprint(b"install-initial");
        let mut install_injected = false;
        let error = write_and_verify_with_hook(
            &install_target,
            b"ours",
            Some(&install_expected),
            |_| Ok(()),
            |point, path| {
                if point == TransitionMutationPoint::BeforeInstall && !install_injected {
                    install_injected = true;
                    fs::write(path, b"late-peer").map_err(|error| error.to_string())?;
                }
                Ok(())
            },
        )
        .expect_err("a peer create after quarantine must conflict");
        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert_eq!(
            fs::read(&install_target).expect("late peer bytes"),
            b"late-peer"
        );

        let changed_quarantine_target = dir.path().join("changed-quarantine.bin");
        fs::write(&changed_quarantine_target, b"quarantine-current").expect("quarantine current");
        let changed_quarantine_expected = transition_artifact_fingerprint(b"quarantine-current");
        let error = write_and_verify_with_hook(
            &changed_quarantine_target,
            b"ours",
            Some(&changed_quarantine_expected),
            |_| Ok(()),
            |point, path| {
                if point == TransitionMutationPoint::BeforeInstall {
                    replace_quarantine_bytes(path, b"peer-quarantine")?;
                }
                Ok(())
            },
        )
        .expect_err("a changed quarantine must not be deleted after install");
        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert_eq!(fs::read(&changed_quarantine_target).expect("installed bytes"), b"ours");
        assert!(dir.path().read_dir().expect("list").any(|entry| {
            let path = entry.expect("entry").path().join("changed-quarantine.bin");
            path.exists() && fs::read(path).expect("changed quarantine") == b"peer-quarantine"
        }));

        let changed_remove_target = dir.path().join("changed-remove-quarantine.bin");
        fs::write(&changed_remove_target, b"remove-current").expect("remove current");
        let changed_remove_expected = transition_artifact_fingerprint(b"remove-current");
        let error = remove_transition_artifact_if_version_with_hook(
            &changed_remove_target,
            &changed_remove_expected,
            &changed_remove_target,
            |point, path| {
                if point == TransitionMutationPoint::BeforeRemoveCommit {
                    replace_quarantine_bytes(path, b"peer-remove-quarantine")?;
                }
                Ok(())
            },
        )
        .expect_err("a changed quarantine must not be deleted after remove");
        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!changed_remove_target.exists());
        assert!(dir.path().read_dir().expect("list").any(|entry| {
            let path = entry.expect("entry").path().join("changed-remove-quarantine.bin");
            path.exists() && fs::read(path).expect("changed quarantine") == b"peer-remove-quarantine"
        }));
    }

    #[test]
    fn transition_create_new_uses_portable_exclusive_copy_without_hard_links() {
        let source_dir = tempfile::tempdir().expect("source temp dir");
        let target_dir = tempfile::tempdir().expect("target temp dir");
        let source = source_dir.path().join("source.bin");
        let target = target_dir.path().join("target.bin");
        fs::write(&source, b"portable copy").expect("source");

        copy_file_create_new(&source, &target).expect("portable create-new copy");
        assert_eq!(fs::read(&target).expect("target"), b"portable copy");
        assert_eq!(
            fs::read(&source).expect("source retained"),
            b"portable copy"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_ne!(
                fs::metadata(&source).expect("source metadata").ino(),
                fs::metadata(&target).expect("target metadata").ino(),
                "create-new must copy bytes instead of requiring a hard link"
            );
        }
        assert_eq!(
            copy_file_create_new(&source, &target).expect_err("must not overwrite"),
            SYNC_FILE_WRITE_CONFLICT,
        );
    }

    #[test]
    fn transition_move_flushes_source_and_destination_metadata_in_order() {
        let source = PathBuf::from("/sync/attachments/item.bin");
        let destination = PathBuf::from("/sync/attachments/.mindwtr-encryption-quarantine/item.bin");
        let events = std::cell::RefCell::new(Vec::new());

        finish_transition_move_durably_with(
            &source,
            &destination,
            |_, _| {
                events.borrow_mut().push("move");
                Ok(())
            },
            |path| {
                events.borrow_mut().push(if path == source {
                    "sync-source-parent"
                } else {
                    "sync-destination-parent"
                });
                Ok(())
            },
        )
        .expect("durable move");

        assert_eq!(
            &*events.borrow(),
            &["move", "sync-source-parent", "sync-destination-parent"]
        );
    }

    #[test]
    fn transition_move_flush_failure_aborts_before_later_metadata_acknowledgement() {
        let source = PathBuf::from("/sync/item.bin");
        let destination = PathBuf::from("/sync/recovery/item.bin");
        let events = std::cell::RefCell::new(Vec::new());

        let error = finish_transition_move_durably_with(
            &source,
            &destination,
            |_, _| {
                events.borrow_mut().push("move");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("sync-source-parent");
                Err(std::io::Error::other("injected flush failure"))
            },
        )
        .expect_err("failed source metadata flush must abort");

        assert!(error.contains("injected flush failure"));
        assert_eq!(&*events.borrow(), &["move", "sync-source-parent"]);
    }

    #[test]
    fn transition_quarantine_neutralization_never_write_opens_the_existing_generation() {
        let dir = tempfile::tempdir().expect("temp dir");
        let scratch_directory = dir.path().join(".mindwtr-encryption-quarantine-test");
        fs::create_dir(&scratch_directory).expect("scratch directory");
        let scratch = TransitionScratch {
            path: scratch_directory.join("data.json"),
            directory: scratch_directory,
        };
        fs::write(&scratch.path, b"retained plaintext").expect("retained generation");
        let replacement = dir.path().join("data.json.enc");
        fs::write(&replacement, b"safe encrypted generation").expect("safe replacement");
        let attempted_existing_write = Cell::new(false);
        let events = std::cell::RefCell::new(Vec::new());

        replace_transition_scratch_with_safe_generation_with(
            &scratch,
            Some(&replacement),
            |path, bytes| {
                events.borrow_mut().push("create-new");
                if path.exists() {
                    attempted_existing_write.set(true);
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "cache-off mount refuses existing-file writes",
                    ));
                }
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)?;
                file.write_all(bytes)?;
                file.sync_all()
            },
            |source, destination| {
                events.borrow_mut().push("replace");
                replace_transition_path_durably(source, destination)
            },
        )
        .expect("create-new plus write-through replace must work without truncation");

        assert!(!attempted_existing_write.get());
        assert_eq!(&*events.borrow(), &["create-new", "replace"]);
        assert_eq!(
            fs::read(&scratch.path).expect("neutralized recovery generation"),
            b"safe encrypted generation"
        );
        assert_eq!(
            scratch.directory.read_dir().expect("scratch entries").count(),
            1,
            "the create-new sibling must be consumed by the replacement move"
        );
    }

    #[test]
    fn transition_quarantine_neutralization_preserves_both_generations_when_replace_fails() {
        let dir = tempfile::tempdir().expect("temp dir");
        let scratch_directory = dir.path().join(".mindwtr-encryption-quarantine-test");
        fs::create_dir(&scratch_directory).expect("scratch directory");
        let scratch = TransitionScratch {
            path: scratch_directory.join("data.json"),
            directory: scratch_directory,
        };
        fs::write(&scratch.path, b"retained plaintext").expect("retained generation");
        let replacement = dir.path().join("data.json.enc");
        fs::write(&replacement, b"safe encrypted generation").expect("safe replacement");

        let error = replace_transition_scratch_with_safe_generation_with(
            &scratch,
            Some(&replacement),
            |path, bytes| {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)?;
                file.write_all(bytes)?;
                file.sync_all()
            },
            |_, _| Err(std::io::Error::other("injected write-through move failure")),
        )
        .expect_err("failed replacement must retain both recovery generations");

        assert!(error.contains("injected write-through move failure"));
        assert_eq!(
            fs::read(&scratch.path).expect("original recovery generation"),
            b"retained plaintext"
        );
        let siblings = scratch
            .directory
            .read_dir()
            .expect("scratch entries")
            .map(|entry| entry.expect("scratch entry").path())
            .filter(|path| path != &scratch.path)
            .collect::<Vec<_>>();
        assert_eq!(siblings.len(), 1);
        assert_eq!(
            fs::read(&siblings[0]).expect("safe recovery generation"),
            b"safe encrypted generation"
        );
    }

    #[test]
    fn transition_cleanup_flushes_file_and_directory_deletions_in_order() {
        let scratch = TransitionScratch {
            directory: PathBuf::from("/sync/.mindwtr-encryption-quarantine-1.cleanup"),
            path: PathBuf::from("/sync/.mindwtr-encryption-quarantine-1.cleanup/item.bin"),
        };
        let events = std::cell::RefCell::new(Vec::new());

        finish_transition_scratch_cleanup_durably_with(
            &scratch,
            true,
            |_| {
                events.borrow_mut().push("remove-file");
                Ok(())
            },
            |_| {
                events.borrow_mut().push("remove-directory");
                Ok(())
            },
            |path| {
                events.borrow_mut().push(if path == scratch.path {
                    "sync-recovery-parent"
                } else {
                    "sync-root-parent"
                });
                Ok(())
            },
        )
        .expect("durable cleanup");

        assert_eq!(
            &*events.borrow(),
            &[
                "remove-file",
                "sync-recovery-parent",
                "remove-directory",
                "sync-root-parent",
            ]
        );
    }

    #[test]
    fn transition_cleanup_flush_failure_keeps_the_recovery_directory() {
        let scratch = TransitionScratch {
            directory: PathBuf::from("/sync/.mindwtr-encryption-quarantine-1.cleanup"),
            path: PathBuf::from("/sync/.mindwtr-encryption-quarantine-1.cleanup/item.bin"),
        };
        let directory_removed = Cell::new(false);

        let error = finish_transition_scratch_cleanup_durably_with(
            &scratch,
            true,
            |_| Ok(()),
            |_| {
                directory_removed.set(true);
                Ok(())
            },
            |_| Err(std::io::Error::other("injected deletion flush failure")),
        )
        .expect_err("unflushed file deletion must abort cleanup");

        assert!(error.contains("injected deletion flush failure"));
        assert!(!directory_removed.get(), "the recovery directory must remain discoverable");
    }

    #[test]
    fn retained_transition_generations_follow_enable_rotation_and_disable_in_place() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let attachment = dir.path().join("attachments").join("a1.png");
        let expected = transition_artifact_fingerprint(b"\x89PNG attachment bytes");
        let mut injected = false;

        let error = write_and_verify_with_hook(
            &attachment,
            b"proposed plaintext generation",
            Some(&expected),
            |_| Ok(()),
            |point, path| {
                if point == TransitionMutationPoint::BeforeQuarantine && !injected {
                    injected = true;
                    fs::write(path, b"peer plaintext generation")
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            },
        )
        .expect_err("injected peer update must retain transition generations");
        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);

        let retained = collect_transition_recovery_artifacts(dir.path()).expect("collect retained");
        assert_eq!(retained.len(), 2, "stage and quarantine must both be retained");
        assert!(retained.iter().all(|path| matches!(
            inspect_sync_artifact(&fs::read(path).expect("retained plaintext")),
            SyncArtifactInspection::Plaintext
        )));

        let first = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("retry enable");
        assert_eq!(
            collect_transition_recovery_artifacts(dir.path()).expect("collect enabled retained"),
            retained
        );
        for path in &retained {
            let sealed = fs::read(path).expect("retained ciphertext");
            assert!(matches!(
                inspect_sync_artifact(&sealed),
                SyncArtifactInspection::Encrypted(_)
            ));
            decrypt_sync_artifact(&sealed, &first.key)
                .unwrap_or_else(|_| panic!("{} must decrypt under enabled key", path.display()));
        }

        let next = change_sync_encryption_passphrase_in_dir(dir.path(), &first.key, "second pass")
            .expect("rotate retained generations");
        assert_eq!(
            collect_transition_recovery_artifacts(dir.path()).expect("collect rotated retained"),
            retained
        );
        for path in &retained {
            let rotated = fs::read(path).expect("rotated recovery generation");
            assert!(decrypt_sync_artifact(&rotated, &first.key).is_err());
            decrypt_sync_artifact(&rotated, &next.key)
                .unwrap_or_else(|_| panic!("{} must decrypt under rotated key", path.display()));
        }

        disable_sync_encryption_in_dir(dir.path(), &next.key).expect("disable retained generations");
        assert_eq!(
            collect_transition_recovery_artifacts(dir.path()).expect("collect opened retained"),
            retained
        );
        for path in &retained {
            assert!(matches!(
                inspect_sync_artifact(&fs::read(path).expect("opened recovery generation")),
                SyncArtifactInspection::Plaintext
            ));
        }
    }

    #[test]
    fn desktop_transitions_recover_mobile_flat_generations_in_place() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let retained = [
            dir.path().join(".mindwtr-et-s-mobile-root"),
            dir.path()
                .join(SYNC_ATTACHMENTS_DIR_NAME)
                .join(".mindwtr-et-q-mobile-attachment"),
        ];
        fs::write(&retained[0], b"mobile retained document generation").expect("root recovery");
        fs::write(&retained[1], b"mobile retained attachment generation")
            .expect("attachment recovery");

        let first = enable_sync_encryption_in_dir(dir.path(), "first pass")
            .expect("enable mobile recovery generations");
        for path in &retained {
            let sealed = fs::read(path).expect("retained ciphertext");
            decrypt_sync_artifact(&sealed, &first.key)
                .unwrap_or_else(|_| panic!("{} must decrypt under enabled key", path.display()));
        }

        let next = change_sync_encryption_passphrase_in_dir(dir.path(), &first.key, "second pass")
            .expect("rotate mobile recovery generations");
        for path in &retained {
            let rotated = fs::read(path).expect("rotated recovery generation");
            assert!(decrypt_sync_artifact(&rotated, &first.key).is_err());
            decrypt_sync_artifact(&rotated, &next.key)
                .unwrap_or_else(|_| panic!("{} must decrypt under rotated key", path.display()));
        }

        disable_sync_encryption_in_dir(dir.path(), &next.key)
            .expect("disable mobile recovery generations");
        assert_eq!(
            fs::read(&retained[0]).expect("opened root recovery"),
            b"mobile retained document generation"
        );
        assert_eq!(
            fs::read(&retained[1]).expect("opened attachment recovery"),
            b"mobile retained attachment generation"
        );
    }

    #[test]
    fn transition_recovery_walk_propagates_directory_read_failure() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let blocked = dir.path().join(".mindwtr-encryption-stage-blocked");
        fs::create_dir(&blocked).expect("blocked recovery directory");
        fs::write(blocked.join(DATA_FILE_NAME), b"retained plaintext").expect("recovery bytes");

        let error = collect_transition_recovery_artifacts_with(dir.path(), |path| {
            if path == blocked {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected traversal failure",
                ))
            } else {
                fs::read_dir(path)
            }
        })
        .expect_err("a recovery enumeration failure must abort the transition");

        assert!(error.contains("injected traversal failure"), "unexpected error: {error}");
        assert!(error.contains(&blocked.display().to_string()), "unexpected error: {error}");
    }

    #[cfg(unix)]
    #[test]
    fn transition_recovery_walk_rejects_symlinks_without_touching_outside_bytes() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("temp dir");
        let outside = tempfile::tempdir().expect("outside temp dir");
        seed_transition_folder(dir.path());
        let outside_artifact = outside.path().join(DATA_FILE_NAME);
        fs::write(&outside_artifact, b"outside plaintext generation").expect("outside bytes");
        symlink(
            outside.path(),
            dir.path().join(".mindwtr-encryption-stage-linked"),
        )
        .expect("recovery symlink");

        let error = enable_sync_encryption_in_dir(dir.path(), "correct horse battery")
            .expect_err("a recovery symlink must fail closed");

        assert!(error.contains("symbolic link"), "unexpected error: {error}");
        assert_eq!(
            fs::read(&outside_artifact).expect("outside bytes retained"),
            b"outside plaintext generation"
        );
        assert!(dir.path().join(DATA_FILE_NAME).exists());
        assert!(!dir.path().join("data.json.enc").exists());
    }

    #[test]
    fn transition_journal_hook_fails_before_any_artifact_mutation() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let plaintext = fs::read(dir.path().join(DATA_FILE_NAME)).expect("plaintext before");
        let attachment_path = dir.path().join(SYNC_ATTACHMENTS_DIR_NAME).join("a1.png");
        let attachment_plaintext = fs::read(&attachment_path).expect("attachment before");

        let error = enable_sync_encryption_in_dir_with(
            dir.path(),
            "first pass",
            || Err("journal blocked enable".to_string()),
            |_, _, _| Ok(()),
        )
        .expect_err("journal failure must abort enable");
        assert_eq!(error, "journal blocked enable");
        assert_eq!(fs::read(dir.path().join(DATA_FILE_NAME)).expect("plaintext after"), plaintext);
        assert_eq!(fs::read(&attachment_path).expect("attachment after"), attachment_plaintext);
        assert!(!dir.path().join("data.json.enc").exists());

        let material = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let encrypted = fs::read(dir.path().join("data.json.enc")).expect("encrypted before");
        let encrypted_attachment = fs::read(&attachment_path).expect("encrypted attachment before");

        let error = disable_sync_encryption_in_dir_with(
            dir.path(),
            &material.key,
            || Err("journal blocked disable".to_string()),
            |_, generation| require_managed_sync_document_generations(generation),
        )
        .expect_err("journal failure must abort disable");
        assert_eq!(error, "journal blocked disable");
        assert_eq!(fs::read(dir.path().join("data.json.enc")).expect("encrypted after"), encrypted);
        assert_eq!(fs::read(&attachment_path).expect("attachment after"), encrypted_attachment);
        assert!(!dir.path().join(DATA_FILE_NAME).exists());

        let error = change_sync_encryption_passphrase_in_dir_with(
            dir.path(),
            &material.key,
            "second pass",
            || Err("journal blocked rotation".to_string()),
            |_, _, _| Ok(()),
        )
        .expect_err("journal failure must abort rotation");
        assert_eq!(error, "journal blocked rotation");
        assert_eq!(fs::read(dir.path().join("data.json.enc")).expect("rotated after"), encrypted);
        assert_eq!(fs::read(&attachment_path).expect("attachment after"), encrypted_attachment);
    }

    #[cfg(unix)]
    #[test]
    fn lock_replacement_during_enable_blocks_final_key_commit_and_second_owner() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let journal_pending = Cell::new(false);
        let persisted = Cell::new(false);

        let error = enable_sync_encryption_in_dir_with(
            dir.path(),
            "first pass",
            || {
                journal_pending.set(true);
                let lock_path = dir.path().join(".mindwtr.lock");
                fs::rename(&lock_path, dir.path().join(".mindwtr.lock.displaced"))
                    .map_err(|error| error.to_string())?;
                fs::write(&lock_path, b"replacement").map_err(|error| error.to_string())?;
                assert_eq!(
                    acquire_sync_lock(dir.path()).expect_err(
                        "the retained root authority must still exclude a second owner"
                    ),
                    "Sync lock held by another process"
                );
                Ok(())
            },
            |_, _, _| {
                persisted.set(true);
                Ok(())
            },
        )
        .expect_err("replaced compatibility lock must abort finalization");

        assert!(error.contains("lock identity changed"), "unexpected error: {error}");
        assert!(journal_pending.get(), "restart recovery must remain explicit");
        assert!(!persisted.get(), "enabled key/state must not commit");
    }

    #[test]
    fn no_op_enable_revalidates_every_managed_document_before_clearing_its_journal() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let material = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let encrypted_path = dir.path().join(encrypted_artifact_name("data.json.bak"));
        let peer = encrypt_sync_artifact(
            br#"{"tasks":[{"id":"peer"}]}"#,
            &material,
        )
        .expect("peer generation");
        let journal_pending = Cell::new(false);
        let persisted = Cell::new(false);

        let error = enable_sync_encryption_in_dir_with(
            dir.path(),
            "first pass",
            || {
                journal_pending.set(true);
                Ok(())
            },
            |_, next, generation| {
                finalize_enabled_file_generation_with(
                    generation,
                    next,
                    || {
                        fs::write(&encrypted_path, &peer).map_err(|error| error.to_string())?;
                        Ok(())
                    },
                    |_| {
                        persisted.set(true);
                        journal_pending.set(false);
                        Ok(())
                    },
                )
            },
        )
        .expect_err("a peer replacement must abort the no-op resume");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(journal_pending.get(), "the retry journal must remain pending");
        assert!(!persisted.get(), "the stale key state must not be persisted");
        assert_eq!(
            fs::read(&encrypted_path).expect("peer generation retained"),
            peer
        );
    }

    #[test]
    fn passphrase_rotation_revalidates_every_managed_document_before_persisting_the_new_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let first = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let encrypted_path = dir.path().join(encrypted_artifact_name("data.json.bak"));
        let journal_pending = Cell::new(false);
        let persisted = Cell::new(false);

        let error = change_sync_encryption_passphrase_in_dir_with(
            dir.path(),
            &first.key,
            "second pass",
            || {
                journal_pending.set(true);
                Ok(())
            },
            |_, next, generation| {
                let peer = encrypt_sync_artifact(
                    br#"{"tasks":[{"id":"peer"}]}"#,
                    next,
                )
                .map_err(|error| terminal_error(error))?;
                finalize_enabled_file_generation_with(
                    generation,
                    next,
                    || {
                        fs::write(&encrypted_path, &peer).map_err(|error| error.to_string())?;
                        Ok(())
                    },
                    |_| {
                        persisted.set(true);
                        journal_pending.set(false);
                        Ok(())
                    },
                )
            },
        )
        .expect_err("a peer replacement must abort key persistence");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(journal_pending.get(), "the retry journal must remain pending");
        assert!(!persisted.get(), "the stale key state must not be persisted");
    }

    #[test]
    fn passphrase_rotation_rejects_an_interrupted_disable_plaintext_generation() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let first = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let encrypted_path = dir.path().join(encrypted_artifact_name(DATA_FILE_NAME));
        let encrypted_before = fs::read(&encrypted_path).expect("encrypted before");
        let plaintext = decrypt_sync_artifact(&encrypted_before, &first.key).expect("open base");
        let plaintext_path = dir.path().join(DATA_FILE_NAME);
        fs::write(&plaintext_path, &plaintext).expect("interrupted disable plaintext");
        let journal_started = Cell::new(false);
        let persisted = Cell::new(false);

        let error = change_sync_encryption_passphrase_in_dir_with(
            dir.path(),
            &first.key,
            "second pass",
            || {
                journal_started.set(true);
                Ok(())
            },
            |_, _, _| {
                persisted.set(true);
                Ok(())
            },
        )
        .expect_err("rotation must not commit while plaintext documents remain");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!journal_started.get(), "posture preflight must run before the journal");
        assert!(!persisted.get(), "the new key must not be persisted");
        assert_eq!(fs::read(&encrypted_path).expect("encrypted retained"), encrypted_before);
        assert_eq!(fs::read(&plaintext_path).expect("plaintext retained"), plaintext);
    }

    #[test]
    fn enable_revalidates_late_attachment_creation_before_persisting_the_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let late = dir.path().join(SYNC_ATTACHMENTS_DIR_NAME).join("late.bin");
        let persisted = Cell::new(false);

        let error = enable_sync_encryption_in_dir_with(
            dir.path(),
            "first pass",
            || Ok(()),
            |_, material, generation| {
                finalize_enabled_file_generation_with(
                    generation,
                    material,
                    || fs::write(&late, b"late plaintext").map_err(|error| error.to_string()),
                    |_| {
                        persisted.set(true);
                        Ok(())
                    },
                )
            },
        )
        .expect_err("late attachment creation must invalidate finalization");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!persisted.get(), "the key must not be persisted");
        assert_eq!(fs::read(&late).expect("late bytes retained"), b"late plaintext");
    }

    #[test]
    fn passphrase_rotation_revalidates_late_attachment_change_before_persisting_the_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let first = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let attachment = dir.path().join(SYNC_ATTACHMENTS_DIR_NAME).join("a1.png");
        let peer = b"peer attachment generation";
        let persisted = Cell::new(false);

        let error = change_sync_encryption_passphrase_in_dir_with(
            dir.path(),
            &first.key,
            "second pass",
            || Ok(()),
            |_, material, generation| {
                finalize_enabled_file_generation_with(
                    generation,
                    material,
                    || fs::write(&attachment, peer).map_err(|error| error.to_string()),
                    |_| {
                        persisted.set(true);
                        Ok(())
                    },
                )
            },
        )
        .expect_err("late attachment replacement must invalidate finalization");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!persisted.get(), "the new key must not be persisted");
        assert_eq!(fs::read(&attachment).expect("peer bytes retained"), peer);
    }

    #[test]
    fn disable_revalidates_late_attachment_removal_before_clearing_the_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let material = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let attachment = dir.path().join(SYNC_ATTACHMENTS_DIR_NAME).join("a1.png");
        let persisted = Cell::new(false);

        let error = disable_sync_encryption_in_dir_with(
            dir.path(),
            &material.key,
            || Ok(()),
            |_, generation| {
                fs::remove_file(&attachment).map_err(|error| error.to_string())?;
                require_managed_sync_document_generations(generation)?;
                persisted.set(true);
                Ok(())
            },
        )
        .expect_err("late attachment removal must invalidate finalization");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!persisted.get(), "disabled state must not be persisted");
        assert!(!attachment.exists(), "the peer removal remains authoritative");
    }

    #[test]
    fn enable_revalidates_late_recovery_creation_before_persisting_the_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let late = dir.path().join(".mindwtr-et-peer-create");
        let persisted = Cell::new(false);

        let error = enable_sync_encryption_in_dir_with(
            dir.path(),
            "first pass",
            || Ok(()),
            |_, material, generation| {
                finalize_enabled_file_generation_with(
                    generation,
                    material,
                    || {
                        fs::write(&late, b"late plaintext recovery")
                            .map_err(|error| error.to_string())
                    },
                    |_| {
                        persisted.set(true);
                        Ok(())
                    },
                )
            },
        )
        .expect_err("late recovery creation must invalidate finalization");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!persisted.get(), "the key must not be persisted");
        assert_eq!(
            fs::read(&late).expect("late recovery retained"),
            b"late plaintext recovery"
        );
    }

    #[test]
    fn passphrase_rotation_revalidates_late_recovery_change_before_persisting_the_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let first = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let recovery = dir.path().join(".mindwtr-et-peer-change");
        let retained =
            encrypt_sync_artifact(b"retained recovery", &first).expect("seal retained");
        fs::write(&recovery, retained).expect("write retained recovery");
        let peer = b"peer recovery generation";
        let persisted = Cell::new(false);

        let error = change_sync_encryption_passphrase_in_dir_with(
            dir.path(),
            &first.key,
            "second pass",
            || Ok(()),
            |_, material, generation| {
                finalize_enabled_file_generation_with(
                    generation,
                    material,
                    || fs::write(&recovery, peer).map_err(|error| error.to_string()),
                    |_| {
                        persisted.set(true);
                        Ok(())
                    },
                )
            },
        )
        .expect_err("late recovery replacement must invalidate finalization");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!persisted.get(), "the new key must not be persisted");
        assert_eq!(fs::read(&recovery).expect("peer recovery retained"), peer);
    }

    #[test]
    fn disable_revalidates_late_recovery_removal_before_clearing_the_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let material = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let recovery = dir.path().join(".mindwtr-et-peer-remove");
        let retained =
            encrypt_sync_artifact(b"retained recovery", &material).expect("seal retained");
        fs::write(&recovery, retained).expect("write retained recovery");
        let persisted = Cell::new(false);

        let error = disable_sync_encryption_in_dir_with(
            dir.path(),
            &material.key,
            || Ok(()),
            |_, generation| {
                fs::remove_file(&recovery).map_err(|error| error.to_string())?;
                require_managed_sync_document_generations(generation)?;
                persisted.set(true);
                Ok(())
            },
        )
        .expect_err("late recovery removal must invalidate finalization");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!persisted.get(), "disabled state must not be persisted");
        assert!(!recovery.exists(), "the peer removal remains authoritative");
    }

    #[test]
    fn disable_revalidates_every_managed_document_before_persisting_disabled_state() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let material = enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let backup_path = dir.path().join("data.json.bak");
        let peer = br#"{"tasks":[{"id":"peer"}]}"#;
        let journal_pending = Cell::new(false);
        let persisted = Cell::new(false);

        let error = disable_sync_encryption_in_dir_with(
            dir.path(),
            &material.key,
            || {
                journal_pending.set(true);
                Ok(())
            },
            |_, generation| {
                fs::write(&backup_path, peer).map_err(|error| error.to_string())?;
                require_managed_sync_document_generations(generation)?;
                persisted.set(true);
                journal_pending.set(false);
                Ok(())
            },
        )
        .expect_err("a peer replacement must abort disabled-state persistence");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(journal_pending.get(), "the retry journal must remain pending");
        assert!(!persisted.get(), "disabled state must not be persisted");
        assert_eq!(fs::read(&backup_path).expect("peer generation retained"), peer);
    }

    #[test]
    fn no_op_enable_revalidates_new_seed_backup_presence_before_persisting_the_key() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let peer_path = dir.path().join("data-backup-peer.json.enc");
        let persisted = Cell::new(false);

        let error = enable_sync_encryption_in_dir_with(
            dir.path(),
            "first pass",
            || Ok(()),
            |_, next, generation| {
                let peer = encrypt_sync_artifact(br#"{"tasks":[{"id":"peer"}]}"#, next)
                    .map_err(|error| terminal_error(error))?;
                finalize_enabled_file_generation_with(
                    generation,
                    next,
                    || {
                        fs::write(&peer_path, peer).map_err(|error| error.to_string())?;
                        Ok(())
                    },
                    |_| {
                        persisted.set(true);
                        Ok(())
                    },
                )
            },
        )
        .expect_err("a newly visible managed generation must abort key persistence");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!persisted.get(), "the stale key must not be persisted");
        assert!(peer_path.exists(), "the peer generation must be retained");
    }

    #[test]
    fn no_op_enable_rejects_an_opposite_generation_created_after_inventory() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let peer_path = dir.path().join(DATA_FILE_NAME);
        let peer = br#"{"tasks":[{"id":"peer-plaintext"}]}"#;
        let persisted = Cell::new(false);

        let error = enable_sync_encryption_in_dir_with(
            dir.path(),
            "first pass",
            || {
                fs::write(&peer_path, peer).map_err(|error| error.to_string())?;
                Ok(())
            },
            |_, next, generation| {
                finalize_enabled_file_generation_with(
                    generation,
                    next,
                    || Ok(()),
                    |_| {
                        persisted.set(true);
                        Ok(())
                    },
                )
            },
        )
        .expect_err("a peer generation created after inventory must abort key persistence");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!persisted.get(), "the stale key must not be persisted");
        assert_eq!(fs::read(&peer_path).expect("peer generation retained"), peer);
    }

    #[test]
    fn rotation_preflights_every_generation_before_starting_its_journal() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let current = enable_sync_encryption_in_dir(dir.path(), "current passphrase")
            .expect("initial enable");
        let foreign = derive_sync_key_material(
            "neither current nor next",
            [47; SALT_LEN],
            SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
        )
        .expect("foreign material");
        let attachment_path = dir.path().join(SYNC_ATTACHMENTS_DIR_NAME).join("a1.png");
        let foreign_attachment = encrypt_sync_artifact(b"foreign attachment", &foreign)
            .expect("seal foreign attachment");
        fs::write(&attachment_path, &foreign_attachment).expect("write foreign attachment");
        let document_path = dir.path().join(encrypted_artifact_name(DATA_FILE_NAME));
        let document_before = fs::read(&document_path).expect("document before");
        let journal_started = Cell::new(false);

        let error = change_sync_encryption_passphrase_in_dir_with(
            dir.path(),
            &current.key,
            "next passphrase",
            || {
                journal_started.set(true);
                Ok(())
            },
            |_, _, _| Ok(()),
        )
        .expect_err("an unknown generation must fail the read-only preflight");

        assert!(is_terminal_error(&error), "unexpected error: {error}");
        assert!(!journal_started.get(), "preflight failure must not start the journal");
        assert_eq!(fs::read(&document_path).expect("document after"), document_before);
        assert_eq!(fs::read(&attachment_path).expect("attachment after"), foreign_attachment);
    }

    #[test]
    fn disable_preflights_every_generation_before_starting_its_journal() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let current = enable_sync_encryption_in_dir(dir.path(), "current passphrase")
            .expect("initial enable");
        let foreign = derive_sync_key_material(
            "foreign passphrase",
            [53; SALT_LEN],
            SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
        )
        .expect("foreign material");
        let attachment_path = dir.path().join(SYNC_ATTACHMENTS_DIR_NAME).join("a1.png");
        let foreign_attachment = encrypt_sync_artifact(b"foreign attachment", &foreign)
            .expect("seal foreign attachment");
        fs::write(&attachment_path, &foreign_attachment).expect("write foreign attachment");
        let document_path = dir.path().join(encrypted_artifact_name(DATA_FILE_NAME));
        let document_before = fs::read(&document_path).expect("document before");
        let journal_started = Cell::new(false);

        let error = disable_sync_encryption_in_dir_with(
            dir.path(),
            &current.key,
            || {
                journal_started.set(true);
                Ok(())
            },
            |_, generation| require_managed_sync_document_generations(generation),
        )
        .expect_err("a foreign generation must fail the read-only preflight");

        assert!(is_terminal_error(&error), "unexpected error: {error}");
        assert!(!journal_started.get(), "preflight failure must not start the journal");
        assert_eq!(fs::read(&document_path).expect("document after"), document_before);
        assert_eq!(fs::read(&attachment_path).expect("attachment after"), foreign_attachment);
    }

    #[test]
    fn a_disable_with_the_wrong_key_changes_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        enable_sync_encryption_in_dir(dir.path(), "first pass").expect("enable");
        let before = fs::read(dir.path().join("data.json.enc")).expect("before");

        let error = disable_sync_encryption_in_dir(dir.path(), &test_material(9).key)
            .expect_err("a wrong key must not disable");

        assert!(is_terminal_error(&error), "expected a terminal error, got: {error}");
        assert_eq!(fs::read(dir.path().join("data.json.enc")).expect("after"), before);
        assert!(!dir.path().join(DATA_FILE_NAME).exists());
    }

    /// Magic present, header short — `inspect_sync_artifact` reports `Unsupported`. Neither
    /// plaintext to seal nor ciphertext to open, so every transition must refuse it.
    fn truncated_container() -> Vec<u8> {
        let mut bytes = b"MWENC1".to_vec();
        bytes.extend_from_slice(&[0u8; 14]);
        bytes
    }

    #[test]
    fn enable_refuses_an_unsupported_container_instead_of_sealing_it_a_second_time() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let attachment = dir.path().join("attachments").join("a1.png");
        fs::write(&attachment, truncated_container()).expect("plant");

        let error = enable_sync_encryption_in_dir(dir.path(), "correct horse battery")
            .expect_err("an unsupported container must not be double-wrapped");

        assert!(is_terminal_error(&error), "expected a terminal error, got: {error}");
        assert_eq!(fs::read(&attachment).expect("attachment"), truncated_container());
        assert!(!dir.path().join("data.json.enc").exists());
        assert!(dir.path().join(DATA_FILE_NAME).exists());
    }

    #[test]
    fn disable_refuses_an_unsupported_container_instead_of_skipping_it_as_plaintext() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let material = enable_sync_encryption_in_dir(dir.path(), "correct horse battery").expect("enable");
        let attachment = dir.path().join("attachments").join("a1.png");
        fs::write(&attachment, truncated_container()).expect("plant");

        let error = disable_sync_encryption_in_dir(dir.path(), &material.key)
            .expect_err("an unsupported container must not be silently left behind");

        assert!(is_terminal_error(&error), "expected a terminal error, got: {error}");
        assert_eq!(fs::read(&attachment).expect("attachment"), truncated_container());
        assert!(dir.path().join("data.json.enc").exists());
        assert!(!dir.path().join(DATA_FILE_NAME).exists());
    }

    #[test]
    fn an_enabled_device_treats_a_peer_disabled_folder_as_terminal_rather_than_empty() {
        // The inverse of `plain_named_ciphertext_is_classified_before_...`: a peer ran the
        // disable transition, so `data.json.enc` is gone and `data.json` is back. Reporting an
        // empty remote here would merge this device's whole store into a fresh plaintext
        // generation and fork the folder permanently.
        let dir = tempfile::tempdir().expect("temp dir");
        let material = test_material(2);
        fs::write(dir.path().join(DATA_FILE_NAME), br#"{"tasks":[{"id":"peer"}]}"#).expect("plain");

        let error = read_sync_file_versioned_from_dir_with(dir.path(), SyncFileCrypto::Enabled(&material))
            .expect_err("a plaintext-restored folder must not read as empty");

        assert_eq!(error, SYNC_ENCRYPTION_REMOTE_PLAINTEXT);
        assert!(is_terminal_error(&error), "the sentinel must classify as terminal");
        assert_eq!(
            fs::read(dir.path().join(DATA_FILE_NAME)).expect("plain"),
            br#"{"tasks":[{"id":"peer"}]}"#
        );
    }

    #[test]
    fn an_enabled_device_still_reads_a_genuinely_empty_folder_as_empty() {
        let dir = tempfile::tempdir().expect("temp dir");
        let material = test_material(3);
        let read = read_sync_file_with_source_from_dir_with(dir.path(), SyncFileCrypto::Enabled(&material))
            .expect("an empty folder is not a fork");
        assert_eq!(read.source, SyncFileReadSource::Empty);
    }

    #[test]
    fn a_stale_plaintext_fork_from_an_old_client_never_shadows_or_loses_the_encrypted_document() {
        // Backward-compat #3: an un-updated peer cannot read `data.json.enc`, sees the data
        // file missing, and may write a stale plaintext `data.json` alongside it. `.enc` stays
        // authoritative and readers never delete or "repair" the fork — a later transition may
        // clean it up, a read never does.
        let dir = tempfile::tempdir().expect("temp dir");
        let material = test_material(1);
        let sealed = seal(br#"{"tasks":[{"id":"encrypted-truth"}]}"#, &material);
        fs::write(dir.path().join("data.json.enc"), &sealed).expect("enc");
        let stale = br#"{"tasks":[{"id":"stale-fork-from-old-client"}]}"#;
        fs::write(dir.path().join(DATA_FILE_NAME), stale).expect("stale fork");

        let crypto = SyncFileCrypto::Enabled(&material);
        let read = read_sync_file_versioned_from_dir_with(dir.path(), crypto).expect("read");
        assert_eq!(read.data["tasks"][0]["id"], "encrypted-truth");
        assert_eq!(read.source, "primary");

        // S4 (mandate #3, the write half): B eventually updates and provides the
        // passphrase. What lands back on the remote must be the result of merging B's
        // OWN diverged local changes (which is what its stale plaintext fork actually
        // represents — B kept syncing against it while it couldn't read `.enc`) into the
        // authoritative encrypted document, losslessly. Rust doesn't run the field-level
        // merge algorithm itself (that's core's `mergeAppDataWithStats`, exercised under
        // encryption separately in packages/core/src/sync-encryption-cycle.test.ts) — its
        // job is the write seam, so this constructs the union a real merge would produce
        // (both task ids present) and proves the write seam carries it through intact,
        // encrypted, and without touching the stale fork.
        let merged = serde_json::json!({ "tasks": [
            { "id": "encrypted-truth" },
            { "id": "stale-fork-from-old-client" },
        ] });
        write_sync_file_to_dir_with(dir.path(), merged, Some(&read.fingerprint), crypto).expect("write");

        // The stale fork is left in place — a transition may clean it up later, a read
        // or write never does.
        assert_eq!(fs::read(dir.path().join(DATA_FILE_NAME)).expect("fork"), stale);

        let reread = read_sync_file_versioned_from_dir_with(dir.path(), crypto).expect("re-read");
        let ids: Vec<&str> = reread.data["tasks"]
            .as_array()
            .expect("tasks array")
            .iter()
            .map(|task| task["id"].as_str().expect("id"))
            .collect();
        assert!(ids.contains(&"encrypted-truth"), "lost device A's change: {ids:?}");
        assert!(ids.contains(&"stale-fork-from-old-client"), "lost device B's diverged change: {ids:?}");
    }

    #[test]
    fn the_encrypted_webdav_url_keeps_the_marker_on_the_path() {
        assert_eq!(
            encrypted_webdav_url("https://host/dav/data.json"),
            "https://host/dav/data.json.enc"
        );
        assert_eq!(
            encrypted_webdav_url("https://host/dav/data.json?token=1"),
            "https://host/dav/data.json.enc?token=1"
        );
        assert_eq!(
            encrypted_webdav_url("https://host/dav/data.json#frag"),
            "https://host/dav/data.json.enc#frag"
        );
    }

    #[test]
    fn webdav_cas_accepts_only_strong_etags_and_builds_create_or_replace_headers() {
        assert_eq!(
            normalize_strong_webdav_etag(Some("  \"v1\"  ")),
            Some("\"v1\"".to_string())
        );
        assert_eq!(normalize_strong_webdav_etag(Some("W/\"v1\"")), None);
        assert_eq!(normalize_strong_webdav_etag(Some("v1")), None);

        let (create_name, create_value) = webdav_write_condition(None).expect("create condition");
        assert_eq!(create_name, reqwest::header::IF_NONE_MATCH);
        assert_eq!(create_value, reqwest::header::HeaderValue::from_static("*"));

        let (replace_name, replace_value) =
            webdav_write_condition(Some("\"v1\"")).expect("replace condition");
        assert_eq!(replace_name, reqwest::header::IF_MATCH);
        assert_eq!(
            replace_value,
            reqwest::header::HeaderValue::from_static("\"v1\"")
        );
        assert!(webdav_write_condition(Some("W/\"v1\"")).is_err());
        assert!(webdav_write_condition(Some("unquoted")).is_err());
    }

    #[test]
    fn invalid_webdav_document_error_carries_the_strong_get_validator() {
        let versioned = invalid_webdav_document_error(
            "Invalid WebDAV response: error decoding response body".to_string(),
            Some("\"broken-v2\""),
        );
        assert!(versioned.contains("[mindwtr-webdav-version:existing:\"broken-v2\"]"));

        let unsafe_version = invalid_webdav_document_error(
            "Invalid WebDAV response: error decoding response body".to_string(),
            None,
        );
        assert!(unsafe_version.contains("[mindwtr-webdav-version:existing:none]"));
    }

    #[test]
    fn webdav_bodies_are_classified_before_being_called_invalid_json() {
        let material = test_material(4);
        let sealed = seal(br#"{"tasks":[]}"#, &material);
        let (salt, params) =
            parse_encrypted_discovery(&webdav_encrypted_discovery(&sealed).expect("discovery"))
                .expect("payload");
        assert_eq!(salt, material.salt);
        assert_eq!(params, material.params);

        // A present-but-unreadable header is still never "repair me".
        let mut unsupported = sealed.clone();
        unsupported[6] = 0x7f; // format_version
        let error = webdav_encrypted_discovery(&unsupported).expect("unsupported is classified");
        assert!(is_terminal_error(&error), "unexpected error: {error}");

        assert!(webdav_encrypted_discovery(br#"{"tasks":[]}"#).is_none());
    }

    #[test]
    fn a_missing_webdav_document_is_classified_per_this_device_s_posture() {
        const PLAIN: &str = "https://host/dav/data.json";
        let material = test_material(5);
        let serving = |served: &'static str, bytes: Vec<u8>| {
            move |target: &str| -> Result<Option<Vec<u8>>, String> {
                Ok((target == served).then(|| bytes.clone()))
            }
        };

        // Keyed device, `.enc` gone, plaintext back: a peer disabled encryption at the sync
        // location. Reading that as an empty remote merges into a fresh generation and forks.
        let plaintext_restored = serving(PLAIN, br#"{"tasks":[]}"#.to_vec());
        let discovery = webdav_absent_document_discovery(&plaintext_restored, PLAIN, Some(&material))
            .expect("probe")
            .expect("a plaintext-restored remote must not read as empty");
        assert_eq!(discovery, SYNC_ENCRYPTION_REMOTE_PLAINTEXT);
        assert!(is_terminal_error(&discovery), "the sentinel must classify as terminal");

        // Genuinely empty remote: nothing at either name, for either posture.
        let empty = |_: &str| -> Result<Option<Vec<u8>>, String> { Ok(None) };
        assert!(webdav_absent_document_discovery(&empty, PLAIN, Some(&material)).expect("probe").is_none());
        assert!(webdav_absent_document_discovery(&empty, PLAIN, None).expect("probe").is_none());

        // Off-state device still discovers the ciphertext a peer wrote.
        let sealed = serving("https://host/dav/data.json.enc", seal(br#"{"tasks":[]}"#, &material));
        let off_state = webdav_absent_document_discovery(&sealed, PLAIN, None)
            .expect("probe")
            .expect("an off-state device must discover the encrypted remote");
        assert!(parse_encrypted_discovery(&off_state).is_some(), "unexpected error: {off_state}");

        let wrong_encrypted_name = serving(
            "https://host/dav/data.json.enc",
            br#"{"tasks":[]}"#.to_vec(),
        );
        let error = webdav_absent_document_discovery(&wrong_encrypted_name, PLAIN, None)
            .expect("probe")
            .expect("plaintext under the encrypted name must be terminal");
        assert!(is_terminal_error(&error), "unexpected error: {error}");

        let wrong_plain_name = serving(PLAIN, seal(br#"{"tasks":[]}"#, &material));
        let error = webdav_absent_document_discovery(&wrong_plain_name, PLAIN, Some(&material))
            .expect("probe")
            .expect("ciphertext under the plaintext name must be terminal");
        assert!(is_terminal_error(&error), "unexpected error: {error}");

        let unavailable = |_: &str| -> Result<Option<Vec<u8>>, String> {
            Err("WebDAV GET failed (500 Internal Server Error)".to_string())
        };
        assert!(webdav_absent_document_discovery(&unavailable, PLAIN, None)
            .expect_err("fallback errors must propagate")
            .contains("500"));
        assert!(webdav_absent_document_discovery(&unavailable, PLAIN, Some(&material))
            .expect_err("fallback errors must propagate")
            .contains("500"));
    }

    #[test]
    fn webdav_optional_fetch_suppresses_only_an_actual_http_404() {
        use std::io::{Read, Write};

        fn serve(status: &'static str, body: &'static str) -> (String, std::thread::JoinHandle<()>) {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind WebDAV test server");
            let address = listener.local_addr().expect("server address");
            let handle = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept WebDAV request");
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                );
                stream.write_all(response.as_bytes()).expect("write WebDAV response");
            });
            (format!("http://{address}/data.json.enc"), handle)
        }

        let client = blocking_http_client(None).expect("client");
        let (missing_url, missing_server) = serve("404 Not Found", "missing");
        assert_eq!(
            webdav_fetch_optional_bytes(&client, &missing_url, "user", "pass").expect("404"),
            None,
        );
        missing_server.join().expect("404 server");

        let (failed_url, failed_server) = serve("500 Internal Server Error", "backend unavailable");
        let error = webdav_fetch_optional_bytes(&client, &failed_url, "user", "pass")
            .expect_err("500 must not mean missing");
        assert!(error.contains("500 Internal Server Error"), "unexpected error: {error}");
        assert!(error.contains("backend unavailable"), "unexpected error: {error}");
        failed_server.join().expect("500 server");
    }

    #[test]
    fn copy_file_sequentially_replaces_the_destination_contents() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("source.json");
        let destination = dir.path().join("destination.json");
        fs::write(&source, b"fresh-contents").expect("write source");
        fs::write(&destination, b"stale-contents-that-is-longer").expect("write destination");

        copy_file_sequentially(&source, &destination).expect("copy");

        assert_eq!(
            fs::read(&destination).expect("read destination"),
            b"fresh-contents"
        );
    }

    #[test]
    fn concurrent_sync_lock_contenders_have_one_owner() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = Arc::new(dir.path().to_path_buf());
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut contenders = Vec::new();
        for _ in 0..2 {
            let path = path.clone();
            let barrier = barrier.clone();
            contenders.push(std::thread::spawn(move || {
                barrier.wait();
                acquire_sync_lock(&path)
            }));
        }
        barrier.wait();

        let results = contenders
            .into_iter()
            .map(|contender| contender.join().expect("contender completes"))
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);

        let owner = results.into_iter().find_map(Result::ok).expect("one owner");
        release_sync_lock(&owner);
    }

    /// Slices `source` from the start of `fn <name>(` to the next top-level
    /// item declaration, the same boundary `write_sync_file_to_dir`'s check
    /// above uses. `name` is built at runtime by the caller (not spelled out
    /// as a literal), so this test's own source text can never be the match.
    fn find_function_body<'a>(source: &'a str, name: &str) -> &'a str {
        let declaration = format!("fn {name}(");
        assert_eq!(
            source.matches(declaration.as_str()).count(),
            1,
            "{name} must be declared exactly once for this check to mean anything"
        );
        let after_decl = source
            .split_once(declaration.as_str())
            .unwrap_or_else(|| panic!("{name} not found"))
            .1;
        let boundaries = ["\n#[tauri::command", "\npub(crate) fn ", "\nfn "];
        let body_end = boundaries
            .iter()
            .filter_map(|marker| after_decl.find(marker))
            .min()
            .unwrap_or(after_decl.len());
        &after_decl[..body_end]
    }

    // I1/V3: every command that writes config.toml through a CRED-only path
    // (update_bound_credential, publish_sync_backend_paths_with, the torn-
    // publication repair or migration writers inside read_sync_backend_
    // publication_state/read_dropbox_credential_state/read_sync_configuration_
    // pair) must hold lock_config_read_modify_write() as its outermost lock,
    // or a concurrent RMW-guarded writer's read..write gap can silently
    // revert it (I1). This list is transcribed from the real call sites, not
    // generated, so it only catches a guard actually being REMOVED - it
    // won't notice a new writer added without one. Red-checked by deleting
    // one guard and confirming the assertion for that function fails.
    #[test]
    fn every_config_toml_writer_holds_the_outer_rmw_lock() {
        let config_source = include_str!("config.rs");
        let functions: &[(&str, &str, &str)] = &[
            ("config.rs", config_source, "get_ai_key"),
            ("config.rs", config_source, "set_ai_key"),
            ("config.rs", config_source, "get_sync_backend"),
            ("config.rs", config_source, "get_sync_cloud_provider"),
            ("config.rs", config_source, "get_sync_cloud_provider_state"),
            (
                "config.rs",
                config_source,
                "get_sync_configuration_snapshot",
            ),
            ("config.rs", config_source, "set_sync_backend"),
            ("config.rs", config_source, "set_sync_cloud_provider"),
            ("config.rs", config_source, "set_obsidian_config"),
            ("config.rs", config_source, "set_webdav_config"),
            ("config.rs", config_source, "set_cloud_config"),
            ("config.rs", config_source, "set_network_proxy"),
            ("config.rs", config_source, "set_external_calendars"),
            (
                "email_capture.rs",
                include_str!("email_capture.rs"),
                "set_email_capture_config",
            ),
            (
                "lib.rs",
                include_str!("lib.rs"),
                "set_desktop_rendering_config",
            ),
            (
                "local_api.rs",
                include_str!("local_api.rs"),
                "write_local_api_config",
            ),
            ("sync.rs", include_str!("sync.rs"), "clear_sync_path"),
            ("sync.rs", include_str!("sync.rs"), "set_sync_path"),
        ];

        for (file, source, name) in functions {
            let body = find_function_body(source, name);
            assert!(
                body.contains("lock_config_read_modify_write()"),
                "{file}: {name} must hold lock_config_read_modify_write() across its \
                 whole body (I1) — without it, a concurrent RMW-guarded writer can \
                 silently revert this function's change to config.toml"
            );
        }
    }

    // The activation probe hands these commands a candidate dir BEFORE
    // set_sync_path has granted it to the webview fs scope, while the probe's
    // attachment step goes through the scope-checked fs plugin. Every
    // override branch must therefore resolve through the scope-granting
    // helper, or candidate probes die on "forbidden path" and a new sync
    // folder can never be saved (#1001). Red-checked by swapping one call
    // back to plain resolve_sync_dir.
    #[test]
    fn sync_file_commands_grant_fs_scope_for_override_paths() {
        let source = include_str!("sync.rs");
        for name in [
            "read_sync_file",
            "read_sync_file_versioned",
            "write_sync_file",
        ] {
            let body = find_function_body(source, name);
            assert!(
                body.contains("resolve_sync_dir_granting_scope"),
                "sync.rs: {name} must resolve its path override via \
                 resolve_sync_dir_granting_scope so the candidate dir is usable \
                 by the fs plugin during the activation probe (#1001)"
            );
        }
    }

    // #1037: tauri-plugin-fs declares exists/mkdir/remove/rename as plain
    // `#[tauri::command]`, so the file-sync attachment step ran hundreds of
    // syscalls on the Tauri main thread and froze the window against a slow
    // mount. The webview only has an off-thread replacement if these four are
    // registered — their (async) declaration is enforced separately by
    // every_plain_tauri_command_is_explicitly_allowed_on_the_main_thread.
    #[test]
    fn sync_folder_fs_commands_are_registered() {
        let source = include_str!("lib.rs");
        let handler = source
            .split_once("tauri::generate_handler![")
            .and_then(|(_, rest)| rest.split_once("])").map(|(commands, _)| commands))
            .expect("Tauri command handler should be present");
        for name in [
            "sync_fs_exists",
            "sync_fs_create_dir",
            "sync_fs_remove_file",
            "sync_fs_rename",
            "sync_fs_stat",
            "sync_fs_reserve_attachment_generation",
            "sync_fs_publish_attachment_generation",
            "sync_fs_abandon_attachment_generation",
        ] {
            assert!(
                handler.contains(&format!("{name},")),
                "lib.rs: {name} must stay registered — without it the sync path \
                 falls back to the fs plugin's main-thread commands (#1037)"
            );
        }
    }

    // Fixtures build on std::env::temp_dir(): a hardcoded "/home/u/..." is not
    // an absolute path on Windows and its ancestry crosses a symlink on the
    // macOS runners, which made this test fail on both platforms while the
    // Linux run stayed green.
    #[test]
    fn sync_fs_paths_are_confined_to_the_managed_dir_and_the_granted_scope() {
        let root = std::env::temp_dir();
        let managed = root.join("mindwtr-sync-fs-test-managed");
        assert!(sync_fs_path_is_allowed(
            &managed.join("attachments/a.txt"),
            &managed,
            false
        ));
        // The sync folder is only ever reachable through the runtime fs scope.
        assert!(sync_fs_path_is_allowed(
            &root.join("mindwtr-sync-fs-test-sync/attachments/a.txt"),
            &managed,
            true
        ));
        assert!(!sync_fs_path_is_allowed(
            &root.join("mindwtr-sync-fs-test-elsewhere/id_ed25519"),
            &managed,
            false
        ));
        // Traversal must not walk out of the managed dir, scope or no scope.
        assert!(!sync_fs_path_is_allowed(
            &managed.join("../../.ssh/id_ed25519"),
            &managed,
            false
        ));
        assert!(!sync_fs_path_is_allowed(
            &managed.join("../../.ssh/id_ed25519"),
            &managed,
            true
        ));
        assert!(!sync_fs_path_is_allowed(
            Path::new("attachments/a.txt"),
            &managed,
            true
        ));
    }

    #[test]
    fn attachment_generation_publication_never_replaces_an_existing_target() {
        let dir = tempfile::tempdir().expect("generation test dir");
        let expected_bytes = b"verified generation";
        let expected_sha256 = bytes_to_hex(&Sha256::digest(expected_bytes));
        let scratch = dir
            .path()
            .join(".mindwtr-attachment-generation-restart.tmp");
        let target = dir
            .path()
            .join(format!("attachment-1.{expected_sha256}.txt"));
        let winning_hash = bytes_to_hex(&Sha256::digest(b"peer winner"));
        let peer_winner = dir.path().join(format!("attachment-1.{winning_hash}.txt"));
        fs::write(&scratch, expected_bytes).expect("seed verified scratch");
        fs::write(&target, b"crash-truncated").expect("seed corrupt prior attempt");
        fs::write(&peer_winner, b"peer winner").expect("seed peer winner");

        let outcome = publish_file_sync_attachment_generation_with(
            &scratch,
            &target,
            expected_bytes.len() as u64,
            &expected_sha256,
            move_no_replace,
            sync_parent_directory_for_durability,
        )
        .expect("an existing generation should be reported without mutation");

        assert_eq!(
            outcome,
            FileSyncAttachmentGenerationPublication::AlreadyExists
        );
        assert_eq!(fs::read(&target).expect("existing target"), b"crash-truncated");
        assert_eq!(
            fs::read(&peer_winner).expect("peer winner remains"),
            b"peer winner"
        );
        assert!(scratch.exists(), "a collision must preserve the owned scratch");
    }

    // `File::sync_all` requires a write-capable handle on Windows. Keep this
    // test platform-neutral so the Windows native job exercises that contract
    // instead of accepting the read-only handle that Unix permits.
    #[test]
    fn attachment_generation_verification_flushes_a_writable_scratch_handle() {
        let dir = tempfile::tempdir().expect("generation flush test dir");
        let expected_bytes = b"verified generation";
        let expected_sha256 = bytes_to_hex(&Sha256::digest(expected_bytes));
        let scratch = dir.path().join(".mindwtr-attachment-generation-flush.tmp");
        fs::write(&scratch, expected_bytes).expect("seed verified scratch");

        verify_and_flush_file_sync_generation_scratch(
            &scratch,
            expected_bytes.len() as u64,
            &expected_sha256,
        )
        .expect("verified scratch must flush on every supported platform");

        assert_eq!(fs::read(&scratch).expect("flushed scratch"), expected_bytes);
    }

    #[test]
    fn attachment_generation_verification_failure_preserves_target_and_scratch() {
        let dir = tempfile::tempdir().expect("generation test dir");
        let expected_sha256 = bytes_to_hex(&Sha256::digest(b"expected"));
        let scratch = dir
            .path()
            .join(".mindwtr-attachment-generation-mismatch.tmp");
        let target = dir
            .path()
            .join(format!("attachment-1.{expected_sha256}.txt"));
        fs::write(&scratch, b"different").expect("seed mismatched scratch");
        fs::write(&target, b"existing generation").expect("seed existing target");

        let error = publish_file_sync_attachment_generation_with(
            &scratch,
            &target,
            b"different".len() as u64,
            &expected_sha256,
            |_source, _destination| panic!("mismatched scratch must not be installed"),
            |_path| panic!("mismatched scratch must not flush target metadata"),
        )
        .expect_err("mismatched scratch must fail closed");

        assert!(error.contains("integrity verification"));
        assert_eq!(
            fs::read(&target).expect("existing target"),
            b"existing generation"
        );
        assert_eq!(fs::read(&scratch).expect("owned scratch"), b"different");
    }

    // The managed dir itself may legitimately sit behind a symlink (portable
    // installs, symlinked $HOME or XDG dirs, macOS's /var and /home): only
    // symlinks BELOW the trust root are traversal.
    #[cfg(unix)]
    #[test]
    fn sync_fs_paths_allow_a_managed_dir_behind_a_symlinked_ancestor() {
        use std::os::unix::fs::symlink;

        let real = tempfile::tempdir().expect("real temp dir");
        let link_root = tempfile::tempdir().expect("link-root temp dir");
        let linked = link_root.path().join("data");
        symlink(real.path(), &linked).expect("create ancestor symlink");
        std::fs::create_dir_all(real.path().join("mindwtr")).expect("create managed dir");
        let managed = linked.join("mindwtr");

        assert!(sync_fs_path_is_allowed(
            &managed.join("attachments/a.txt"),
            &managed,
            false
        ));
    }

    #[cfg(unix)]
    #[test]
    fn sync_fs_paths_reject_symlink_components_inside_an_allowed_tree() {
        use std::os::unix::fs::symlink;

        let managed = tempfile::tempdir().expect("managed temp dir");
        let outside = tempfile::tempdir().expect("outside temp dir");
        let redirected = managed.path().join("redirected");
        symlink(outside.path(), &redirected).expect("create directory symlink");

        assert!(!sync_fs_path_is_allowed(
            &redirected.join("external.txt"),
            managed.path(),
            false
        ));
    }

    /// (name, is_async) for every `#[tauri::command...]` declaration found in
    /// `source`, in source order. Scans forward from each attribute occurrence
    /// (not backward from a known name), so it finds commands this test never
    /// heard of — the whole point of inverting the old hardcoded-list check.
    fn tauri_command_declarations(source: &str) -> Vec<(String, bool)> {
        let marker = "#[tauri::command";
        let mut declarations = Vec::new();
        let mut cursor = 0usize;
        while let Some(relative) = source[cursor..].find(marker) {
            let attr_start = cursor + relative;
            // A real attribute starts its own line (only whitespace before it
            // since the last newline). This crate's source also mentions the
            // literal text `#[tauri::command` inside comments and this very
            // test's own strings — those aren't line-starting and must not
            // count as a declaration.
            let line_start = source[..attr_start].rfind('\n').map_or(0, |i| i + 1);
            let is_real_attribute = source[line_start..attr_start].trim().is_empty();
            if !is_real_attribute {
                cursor = attr_start + marker.len();
                continue;
            }
            let after_attr = &source[attr_start + marker.len()..];
            let attribute_is_async = after_attr.starts_with("(async)");
            // The real declaration follows within a handful of lines
            // (attribute, maybe another attribute or doc comment, then
            // `pub(crate) [async] fn name(`). Bound the search so a later,
            // unrelated `fn ` deep in the file can't be mistaken for it.
            let window_len = after_attr.len().min(400);
            let window = &after_attr[..window_len];
            let fn_relative = window
                .find("fn ")
                .unwrap_or_else(|| panic!(
                    "no `fn` declaration within 400 chars after a #[tauri::command] attribute at byte {attr_start}"
                ));
            // `#[tauri::command]` (no `(async)`) on an `async fn` already runs
            // off the main thread — Tauri hands async fns to the async
            // runtime regardless of the attribute. `(async)` is specifically
            // for moving a blocking (sync) fn to the blocking pool. So a
            // command is safe if EITHER the attribute says (async) OR the fn
            // itself is declared `async fn`.
            let fn_is_async = window[..fn_relative].trim_end().ends_with("async");
            let is_async = attribute_is_async || fn_is_async;
            let after_fn = &window[fn_relative + "fn ".len()..];
            let name_end = after_fn.find('(').unwrap_or(after_fn.len());
            let name = after_fn[..name_end].trim().to_string();
            declarations.push((name, is_async));
            cursor = attr_start + marker.len();
        }
        declarations
    }

    #[test]
    fn every_plain_tauri_command_is_explicitly_allowed_on_the_main_thread() {
        // A plain `#[tauri::command]` on a blocking fn runs on the Tauri
        // main/event-loop thread, so any real I/O in its body freezes the
        // whole window until it returns — a slow sync mount, an IMAP round
        // trip, an Obsidian vault write on a network share or FUSE mount, a
        // snapshot/query against SQLite on a cache-off rclone/WinFSP mount
        // (R-01, storage.rs's five snapshot/query/search commands — the
        // hardcoded 11-name list this test used to check missed them
        // entirely; this scans every command in the crate instead).
        //
        // Each entry: (command name, one-line reason it's safe as-is — pure
        // in-memory/state access, or an OS window/tray/hotkey API call that
        // is inherently main-thread-bound in most GUI toolkits, not merely
        // "fast today". Every entry below was read end to end before listing.
        const ALLOWED_MAIN_THREAD_COMMANDS: &[(&str, &str)] = &[
            (
                "consume_quick_add_pending",
                "only a Mutex-guarded in-memory field swap",
            ),
            (
                "set_global_quick_add_shortcut",
                "OS global-hotkey (un)registration, inherently main/event-loop-bound",
            ),
            (
                "set_tray_visible",
                "tray-icon visibility is a live GUI-toolkit object mutation, no I/O",
            ),
            (
                "set_tray_tooltip",
                "tray-icon tooltip is a live GUI-toolkit object mutation (no-op on Linux)",
            ),
            (
                "notify_ui_ready",
                "window show/focus/activation-policy calls only, no I/O in the call graph",
            ),
            (
                "hide_quick_add_window",
                "window hide + foreground-window restore, OS window API only",
            ),
            (
                "cloudkit_consume_pending_remote_change",
                "only flips an in-process flag set by the CloudKit callback",
            ),
            (
                "cloudkit_register_for_notifications",
                "one-time OS push-notification registration, no CloudKit round trip parsed",
            ),
            (
                "get_managed_data_dir",
                "builds a path string; the only I/O is one Path::exists() stat",
            ),
            (
                "set_macos_activation_policy",
                "synchronous NSApplication activation-policy setter, no I/O",
            ),
            (
                "get_data_path_cmd",
                "builds a path string; the only I/O is one Path::exists() stat",
            ),
            (
                "get_db_path_cmd",
                "builds a path string; the only I/O is one Path::exists() stat",
            ),
            ("get_dropbox_redirect_uri", "pure string builder, no I/O"),
            (
                "discard_staged_dropbox_credentials",
                "only mutates an in-memory Mutex-guarded staged-credential map",
            ),
            (
                "acknowledge_close_request",
                "shutdown ordering outranks responsiveness here; the log-append is a \
                 bounded single-line file write, and making quit racy with teardown \
                 (via the async thread pool) risks losing the close acknowledgment (B3)",
            ),
            (
                "quit_app",
                "same shutdown-ordering rationale as acknowledge_close_request — \
                 app.exit(0) must not race a backgrounded caller (B3)",
            ),
        ];

        // Known-unfixed debt this inversion uncovered beyond R-01's five
        // (each does real file/keyring/SQLite/EventKit/process I/O — read
        // every one before trusting this comment, don't extend it casually).
        // Shrink-only: never add a name here — a new plain command must
        // become (async) or get a justified ALLOWED_MAIN_THREAD_COMMANDS
        // entry. Remove an entry in the same commit that fixes it; the test
        // below fails if an entry here is no longer a plain command, so a fix
        // that forgets to remove its own baseline line doesn't silently pass.
        // B3 emptied this baseline: config.rs's 19 getters/setters are now
        // (async), each either behind lock_config_read_modify_write, already
        // covered by an internal lock_dropbox_credential_state hold, or a
        // pure read with no write branch; ui.rs's two shutdown commands moved
        // to ALLOWED_MAIN_THREAD_COMMANDS above with a documented rationale.
        // Stays empty — see the comment above this const for what refills it.
        const KNOWN_BLOCKING_COMMANDS: &[&str] = &[];

        // Enumerated, not hand-listed: the roster this replaced named 16 files
        // and silently skipped macos_widget.rs for its whole life, so the one
        // command it added never faced this check. A new module is now covered
        // the moment it lands.
        let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut sources: Vec<(String, String)> = std::fs::read_dir(&src_dir)
            .expect("should read the crate's src directory")
            .map(|entry| entry.expect("should read a src directory entry").path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "rs"))
            .map(|path| {
                let name = path
                    .file_name()
                    .expect("a .rs path has a file name")
                    .to_string_lossy()
                    .to_string();
                let source = std::fs::read_to_string(&path)
                    .unwrap_or_else(|error| panic!("should read {name}: {error}"));
                (name, source)
            })
            .collect();
        sources.sort();
        // A mistyped directory would enumerate nothing and pass vacuously.
        assert!(
            sources.len() >= 16,
            "expected the whole crate's sources, found {}",
            sources.len()
        );

        let allowed_names: std::collections::HashSet<&str> = ALLOWED_MAIN_THREAD_COMMANDS
            .iter()
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(
            allowed_names.len(),
            ALLOWED_MAIN_THREAD_COMMANDS.len(),
            "ALLOWED_MAIN_THREAD_COMMANDS has a duplicate entry"
        );
        let known_blocking: std::collections::HashSet<&str> =
            KNOWN_BLOCKING_COMMANDS.iter().copied().collect();
        assert_eq!(
            known_blocking.len(),
            KNOWN_BLOCKING_COMMANDS.len(),
            "KNOWN_BLOCKING_COMMANDS has a duplicate entry"
        );
        assert!(
            allowed_names.is_disjoint(&known_blocking),
            "a command can't be both explicitly allowed and known-blocking debt"
        );

        let mut seen_known_blocking: std::collections::HashSet<&str> =
            std::collections::HashSet::new();
        let mut violations: Vec<String> = Vec::new();
        for (file, source) in &sources {
            for (name, is_async) in tauri_command_declarations(source) {
                if is_async || allowed_names.contains(name.as_str()) {
                    continue;
                }
                if known_blocking.contains(name.as_str()) {
                    seen_known_blocking.insert(
                        *known_blocking
                            .get(name.as_str())
                            .expect("just checked contains"),
                    );
                    continue;
                }
                violations.push(format!(
                    "{name} ({file}) is a new plain command outside both lists — \
                     mark it #[tauri::command(async)], or add a justified \
                     ALLOWED_MAIN_THREAD_COMMANDS entry if it's genuinely safe, \
                     or a KNOWN_BLOCKING_COMMANDS entry if it's real unfixed debt"
                ));
            }
        }
        // Shrink-only: a baseline entry that's no longer a plain command means
        // its fix landed without removing the debt marker — fail so that
        // removal happens in the same commit as the fix, not forgotten.
        for stale in known_blocking.difference(&seen_known_blocking) {
            violations.push(format!(
                "{stale} is listed in KNOWN_BLOCKING_COMMANDS but is no longer a \
                 plain command — remove it from the baseline"
            ));
        }

        assert!(
            violations.is_empty(),
            "blocking-command governance check failed:\n{violations:#?}"
        );
    }

    #[test]
    fn empty_remote_app_data_includes_every_app_data_array_surface() {
        // Regression for #990: a fresh sync folder handed the JS sync cycle a
        // partial remote (missing `sections`/`people`), which crashed
        // downstream code that assumes every AppData array is present.
        let payload = empty_remote_app_data();
        for field in ["tasks", "projects", "sections", "areas", "people"] {
            assert!(
                payload
                    .get(field)
                    .and_then(|value| value.as_array())
                    .is_some(),
                "empty_remote_app_data is missing AppData array surface {field:?}"
            );
        }
        assert!(payload
            .get("settings")
            .and_then(|value| value.as_object())
            .is_some());
    }

    fn test_dropbox_tokens(label: &str, expires_at: i64) -> DropboxTokenBundle {
        DropboxTokenBundle {
            client_id: "client-id".to_string(),
            access_token: format!("{label}-access"),
            refresh_token: format!("{label}-refresh"),
            expires_at,
        }
    }

    #[test]
    fn clearing_dropbox_tokens_propagates_keyring_deletion_failure() {
        let fallback_cleared = std::cell::Cell::new(false);
        let error = clear_dropbox_tokens_with(
            || {
                fallback_cleared.set(true);
                Ok(())
            },
            || Ok(false),
            || Ok(true),
            || Err("keyring deletion failed".to_string()),
        )
        .expect_err("a real keyring deletion failure must fail disconnect");

        assert!(fallback_cleared.get());
        assert!(error.contains("keyring deletion failed"));
    }

    #[test]
    fn clearing_dropbox_tokens_rejects_a_partial_keyring_deletion() {
        let keyring_reads = std::cell::Cell::new(0usize);
        let error = clear_dropbox_tokens_with(
            || Ok(()),
            || Ok(false),
            || {
                let read = keyring_reads.get();
                keyring_reads.set(read + 1);
                Ok(true)
            },
            || Ok(()),
        )
        .expect_err("a keyring write without matching read-back must fail");

        assert!(error.contains("durable read-back verification"));
        assert!(keyring_reads.get() >= 2);
    }

    #[test]
    fn disconnect_clears_dormant_dropbox_state_for_known_non_cloud_backends() {
        use std::cell::{Cell, RefCell};

        for backend in ["off", "file", "webdav", "cloudkit"] {
            let backend_state = RefCell::new(backend.to_string());
            let tokens = test_dropbox_tokens("dormant", 100_000);
            let active = RefCell::new(Some(tokens.clone()));
            let journal_present = Cell::new(true);
            let staged_present = Cell::new(true);

            let token_to_revoke = prepare_dropbox_disconnect_with(
                "client-id",
                || {
                    Ok(inferred_dropbox_recovery_commit_state(
                        backend_state.borrow().clone(),
                    ))
                },
                || Ok(None),
                || Ok(()),
                || Ok(active.borrow().clone()),
                || {
                    *active.borrow_mut() = None;
                    Ok(())
                },
                || {
                    journal_present.set(false);
                    Ok(())
                },
                || staged_present.set(false),
            )
            .unwrap_or_else(|error| panic!("{backend} should allow disconnect: {error}"));

            assert_eq!(token_to_revoke, Some(tokens));
            assert_eq!(backend_state.borrow().as_str(), backend);
            assert!(active.borrow().is_none());
            assert!(!journal_present.get());
            assert!(!staged_present.get());
        }
    }

    #[test]
    fn disconnect_rejects_cloud_unknown_and_unreadable_backends_without_mutation() {
        use std::cell::Cell;

        for backend in ["cloud", "future-backend", ""] {
            let post_guard_calls = Cell::new(0usize);
            let error = prepare_dropbox_disconnect_with(
                "client-id",
                || Ok(inferred_dropbox_recovery_commit_state(backend.to_string())),
                || Ok(None),
                || {
                    post_guard_calls.set(post_guard_calls.get() + 1);
                    Ok(())
                },
                || {
                    post_guard_calls.set(post_guard_calls.get() + 1);
                    Ok(None)
                },
                || {
                    post_guard_calls.set(post_guard_calls.get() + 1);
                    Ok(())
                },
                || {
                    post_guard_calls.set(post_guard_calls.get() + 1);
                    Ok(())
                },
                || post_guard_calls.set(post_guard_calls.get() + 1),
            )
            .expect_err("unsafe or unknown backend must fail closed");
            assert!(error.contains("disconnect"));
            assert_eq!(post_guard_calls.get(), 0);
        }

        let post_guard_calls = Cell::new(0usize);
        let error = prepare_dropbox_disconnect_with(
            "client-id",
            || Err("corrupt config".to_string()),
            || Ok(None),
            || {
                post_guard_calls.set(post_guard_calls.get() + 1);
                Ok(())
            },
            || {
                post_guard_calls.set(post_guard_calls.get() + 1);
                Ok(None)
            },
            || {
                post_guard_calls.set(post_guard_calls.get() + 1);
                Ok(())
            },
            || {
                post_guard_calls.set(post_guard_calls.get() + 1);
                Ok(())
            },
            || post_guard_calls.set(post_guard_calls.get() + 1),
        )
        .expect_err("unreadable backend must fail closed");
        assert!(error.contains("corrupt config"));
        assert_eq!(post_guard_calls.get(), 0);
    }

    #[test]
    fn disconnect_allows_dormant_dropbox_credentials_during_active_selfhosted_sync() {
        use std::cell::{Cell, RefCell};

        let active = RefCell::new(Some(test_dropbox_tokens("dormant", 100_000)));
        let cleared = Cell::new(0usize);
        let token_to_revoke = prepare_dropbox_disconnect_with(
            "client-id",
            || {
                Ok(DropboxRecoveryCommitState {
                    raw_backend: "cloud".to_string(),
                    backend_marker: "cloud".to_string(),
                    cloud_provider: "selfhosted".to_string(),
                    cloud_provider_authority: "native".to_string(),
                })
            },
            || Ok(None),
            || Ok(()),
            || Ok(active.borrow().clone()),
            || {
                cleared.set(cleared.get() + 1);
                *active.borrow_mut() = None;
                Ok(())
            },
            || {
                cleared.set(cleared.get() + 1);
                Ok(())
            },
            || cleared.set(cleared.get() + 1),
        )
        .expect("self-hosted cloud does not consume dormant Dropbox credentials");

        assert!(token_to_revoke.is_some());
        assert!(active.borrow().is_none());
        assert_eq!(cleared.get(), 3);
    }

    #[test]
    fn disconnect_rejects_backend_marker_mismatch_before_any_mutation() {
        use std::cell::Cell;

        let mutations = Cell::new(0usize);
        let error = prepare_dropbox_disconnect_with(
            "client-id",
            || {
                Ok(DropboxRecoveryCommitState {
                    raw_backend: "cloud".to_string(),
                    backend_marker: "off".to_string(),
                    cloud_provider: "selfhosted".to_string(),
                    cloud_provider_authority: "native".to_string(),
                })
            },
            || Ok(None),
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(None)
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || mutations.set(mutations.get() + 1),
        )
        .expect_err("inconsistent native markers fail closed");

        assert!(error.contains("inconsistent"));
        assert_eq!(mutations.get(), 0);
    }

    #[test]
    fn disconnect_rejects_uninitialized_provider_authority_before_any_mutation() {
        use std::cell::Cell;

        let mutations = Cell::new(0usize);
        let error = prepare_dropbox_disconnect_with(
            "client-id",
            || {
                Ok(DropboxRecoveryCommitState {
                    raw_backend: "cloud".to_string(),
                    backend_marker: "cloud".to_string(),
                    cloud_provider: "selfhosted".to_string(),
                    cloud_provider_authority: "uninitialized".to_string(),
                })
            },
            || panic!("provider authority guard runs before journal inspection"),
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(None)
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || mutations.set(mutations.get() + 1),
        )
        .expect_err("uninitialized cloud provider authority must fail closed");

        assert!(error.contains("authority is uninitialized"));
        assert_eq!(mutations.get(), 0);
    }

    #[test]
    fn disconnect_refuses_a_pending_journal_after_the_backend_changed() {
        use std::cell::Cell;

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let journal = build_dropbox_promotion_journal(previous, &candidate)
            .expect("build pending promotion journal");
        let mutations = Cell::new(0usize);

        let error = prepare_dropbox_disconnect_with(
            "client-id",
            || Ok(inferred_dropbox_recovery_commit_state("off".to_string())),
            || Ok(Some(journal.clone())),
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(Some(candidate.clone()))
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || {
                mutations.set(mutations.get() + 1);
                Ok(())
            },
            || mutations.set(mutations.get() + 1),
        )
        .expect_err("disconnect must not reclassify a possibly committed journal");

        assert!(error.contains("recovery must settle before the sync backend changes"));
        assert_eq!(mutations.get(), 0);
    }

    #[test]
    fn connect_candidate_staging_preserves_each_active_backend_without_a_journal() {
        use std::cell::RefCell;

        for backend in ["file", "webdav", "cloudkit", "cloud"] {
            let backend_state = RefCell::new(backend.to_string());
            let durable_tokens = RefCell::new(Some(test_dropbox_tokens("active", 90_000)));
            let mut entries = HashMap::new();
            let candidate = test_dropbox_tokens("candidate", 100_000);

            stage_dropbox_candidate_after_recovery_with(
                || {
                    recover_dropbox_credentials_fail_closed_with(
                        || Ok(backend_state.borrow().clone()),
                        |_next| panic!("no-journal connect must not rewrite the backend"),
                        || panic!("no-journal connect must not inspect durable credentials"),
                        |_tokens| panic!("no-journal connect must not rewrite durable credentials"),
                        || Ok(None),
                        || panic!("no-journal connect must not clear an absent journal"),
                    )
                },
                || {
                    insert_staged_dropbox_credentials(
                        &mut entries,
                        "opaque-handle".to_string(),
                        candidate.clone(),
                        100,
                    )
                },
            )
            .unwrap_or_else(|error| panic!("{backend} should permit candidate staging: {error}"));

            assert_eq!(backend_state.borrow().as_str(), backend);
            assert_eq!(
                *durable_tokens.borrow(),
                Some(test_dropbox_tokens("active", 90_000))
            );
            assert!(matches!(
                entries.get("opaque-handle").map(|entry| &entry.phase),
                Some(DropboxStagedCredentialPhase::Candidate)
            ));
            let refreshed = resolve_staged_dropbox_access_token_with(
                &mut entries,
                "opaque-handle",
                "client-id",
                true,
                200,
                |_client_id, _refresh_token| {
                    Ok(("refreshed-candidate-access".to_string(), 120_000))
                },
            )
            .expect("Candidate refresh remains memory-only under the active backend");
            assert_eq!(refreshed, "refreshed-candidate-access");
            discard_staged_dropbox_credentials_in_store(
                &mut entries,
                "opaque-handle",
                "client-id",
                300,
            )
            .expect("Candidate discard remains memory-only under the active backend");
            assert!(!entries.contains_key("opaque-handle"));
            assert_eq!(backend_state.borrow().as_str(), backend);
            assert_eq!(
                *durable_tokens.borrow(),
                Some(test_dropbox_tokens("active", 90_000))
            );
        }
    }

    #[test]
    fn connect_candidate_staging_stops_without_rolling_back_a_committed_mismatch() {
        use std::cell::{Cell, RefCell};

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let backend = RefCell::new("cloud".to_string());
        let active = RefCell::new(Some(test_dropbox_tokens("mismatch", 100_000)));
        let journal = RefCell::new(Some(
            build_dropbox_promotion_journal(previous.clone(), &candidate)
                .expect("build connect recovery journal"),
        ));
        let stage_calls = Cell::new(0usize);

        let error = stage_dropbox_candidate_after_recovery_with(
            || {
                recover_dropbox_credentials_fail_closed_with(
                    || Ok(backend.borrow().clone()),
                    |next| {
                        *backend.borrow_mut() = next.to_string();
                        Ok(())
                    },
                    || Ok(active.borrow().clone()),
                    |tokens| {
                        *active.borrow_mut() = tokens.cloned();
                        Ok(())
                    },
                    || Ok(journal.borrow().clone()),
                    || {
                        *journal.borrow_mut() = None;
                        Ok(())
                    },
                )
            },
            || {
                stage_calls.set(stage_calls.get() + 1);
                Ok(())
            },
        )
        .expect_err("mismatched cloud journal must abort candidate staging");

        assert!(error.contains("active Dropbox commit was left intact"));
        assert_eq!(backend.borrow().as_str(), "cloud");
        assert_eq!(
            *active.borrow(),
            Some(test_dropbox_tokens("mismatch", 100_000))
        );
        assert!(journal.borrow().is_some());
        assert_eq!(stage_calls.get(), 0);
    }

    #[test]
    fn keyring_error_fallback_round_trips_promotion_recovery_and_rollback() {
        use std::cell::RefCell;

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let fallback = RefCell::new(
            previous
                .as_ref()
                .map(|tokens| serde_json::to_string(tokens).expect("serialize previous")),
        );
        let journal = RefCell::new(None::<DropboxCredentialPromotionJournal>);
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            candidate.clone(),
            100,
        )
        .expect("stage candidate");

        let read_active = || {
            read_dropbox_tokens_for_recovery_with(
                || Err("desktop keyring unavailable".to_string()),
                || Ok(fallback.borrow().clone()),
            )
        };
        let write_active = |tokens: Option<&DropboxTokenBundle>| {
            *fallback.borrow_mut() = tokens
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| "serialize fallback tokens".to_string())?;
            Ok(())
        };

        promote_staged_dropbox_credentials_with_journal(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || Ok("off".to_string()),
            || {
                read_dropbox_previous_credentials_for_promotion_with(
                    || Err("desktop keyring unavailable".to_string()),
                    || Ok(fallback.borrow().clone()),
                )
            },
            read_active,
            write_active,
            |tokens| {
                *fallback.borrow_mut() = Some(
                    serde_json::to_string(tokens)
                        .map_err(|_| "serialize fallback tokens".to_string())?,
                );
                Ok(())
            },
            || Ok(journal.borrow().clone()),
            |next| {
                *journal.borrow_mut() = Some(next.clone());
                Ok(())
            },
        )
        .expect("fallback-backed promotion and read-back should succeed");
        assert_eq!(
            read_active().expect("read promoted fallback"),
            Some(candidate)
        );

        recover_dropbox_promotion_journal_with(
            || Ok("off".to_string()),
            read_active,
            write_active,
            || Ok(journal.borrow().clone()),
            || {
                *journal.borrow_mut() = None;
                Ok(())
            },
        )
        .expect("fallback-backed crash recovery should restore previous credentials");
        assert_eq!(read_active().expect("read recovered fallback"), previous);

        rollback_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            300,
            read_active,
            write_active,
        )
        .expect("fallback-backed promoted handle remains rollbackable");
        assert_eq!(read_active().expect("read rolled back fallback"), previous);
    }

    #[test]
    fn keyring_error_without_dropbox_fallback_remains_fail_closed() {
        let error = read_dropbox_tokens_for_recovery_with(
            || Err("desktop keyring unavailable".to_string()),
            || Ok(None),
        )
        .expect_err("unknown keyring contents cannot be treated as empty");

        assert!(error.contains("inspect Dropbox credentials"));
    }

    #[test]
    fn recovery_token_fallback_overrides_stale_keyring_bytes_after_outage() {
        let stale = test_dropbox_tokens("stale-keyring", 90_000);
        let candidate = test_dropbox_tokens("fallback-candidate", 100_000);
        let candidate_payload =
            serde_json::to_string(&candidate).expect("serialize fallback candidate");

        let recovered = read_dropbox_tokens_for_recovery_with(
            || {
                Ok(Some(
                    serde_json::to_string(&stale).expect("serialize stale keyring"),
                ))
            },
            || Ok(Some(candidate_payload.clone())),
        )
        .expect("authoritative fallback should remain readable");

        assert_eq!(recovered, Some(candidate));
    }

    #[test]
    fn corrupt_recovery_token_fallback_fails_closed_before_keyring_use() {
        let keyring_reads = std::cell::Cell::new(0usize);
        let error = read_dropbox_tokens_for_recovery_with(
            || {
                keyring_reads.set(keyring_reads.get() + 1);
                Ok(Some(
                    serde_json::to_string(&test_dropbox_tokens("keyring", 90_000))
                        .expect("serialize keyring"),
                ))
            },
            || Err("corrupt private fallback".to_string()),
        )
        .expect_err("corrupt fallback authority must fail closed");

        assert!(error.contains("corrupt private fallback"));
        assert_eq!(keyring_reads.get(), 0);
    }

    #[test]
    fn dropbox_connection_status_never_deletes_credentials_after_a_read_failure() {
        use std::cell::Cell;

        let clear_attempts = Cell::new(0usize);
        let error = is_dropbox_connected_with("client-id", || {
            Err("Failed to inspect Dropbox credentials".to_string())
        })
        .expect_err("transient read failure must be reported");

        // An explicit disconnect could make this closure succeed, but status
        // inspection never receives or invokes a deletion capability.
        let potentially_successful_delete = || {
            clear_attempts.set(clear_attempts.get() + 1);
            Ok::<(), String>(())
        };
        let _ = potentially_successful_delete;
        assert!(error.contains("Failed to inspect Dropbox credentials"));
        assert_eq!(clear_attempts.get(), 0);
    }

    #[test]
    fn dropbox_connection_status_reports_corruption_without_mutation() {
        let error = is_dropbox_connected_with("client-id", || {
            parse_dropbox_token_bundle("not-json").map(Some)
        })
        .expect_err("corrupt credentials are not equivalent to disconnected");

        assert!(error.contains("invalid"));
    }

    #[test]
    fn first_connect_can_promote_commit_and_finalize_during_keyring_outage() {
        use std::cell::{Cell, RefCell};

        let candidate = test_dropbox_tokens("candidate", 100_000);
        let fallback = RefCell::new(None::<String>);
        let journal = RefCell::new(None::<DropboxCredentialPromotionJournal>);
        let token_keyring_set_calls = Cell::new(0usize);
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            candidate.clone(),
            100,
        )
        .expect("stage candidate");

        let read_active = || {
            read_dropbox_tokens_for_recovery_with(
                || Err("keyring unavailable".to_string()),
                || Ok(fallback.borrow().clone()),
            )
        };
        promote_staged_dropbox_credentials_with_journal(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || Ok("off".to_string()),
            || {
                read_dropbox_previous_credentials_for_promotion_with(
                    || Err("keyring unavailable".to_string()),
                    || Ok(fallback.borrow().clone()),
                )
            },
            read_active,
            |_tokens| {
                token_keyring_set_calls.set(token_keyring_set_calls.get() + 1);
                Err("keyring set succeeded but verification read failed".to_string())
            },
            |tokens| {
                *fallback.borrow_mut() = Some(
                    serde_json::to_string(tokens).map_err(|_| "serialize fallback".to_string())?,
                );
                Ok(())
            },
            || Ok(journal.borrow().clone()),
            |next| {
                *journal.borrow_mut() = Some(next.clone());
                Ok(())
            },
        )
        .expect("unknown prior keyring state permits fallback-backed first promotion");

        assert!(matches!(
            journal.borrow().as_ref().map(|journal| &journal.previous),
            Some(DropboxPreviousCredentials::UnknownKeyring)
        ));
        assert_eq!(token_keyring_set_calls.get(), 0);
        assert_eq!(
            read_active().expect("read candidate fallback"),
            Some(candidate.clone())
        );

        recover_dropbox_credentials_fail_closed_with_commit_state(
            || {
                Ok(DropboxRecoveryCommitState {
                    raw_backend: "cloud".to_string(),
                    backend_marker: "cloud".to_string(),
                    cloud_provider: "dropbox".to_string(),
                    cloud_provider_authority: "native".to_string(),
                })
            },
            |_backend| panic!("exact committed Dropbox state must not be disabled"),
            read_active,
            |_journal| panic!("committed candidate does not resolve unknown prior state"),
            |_tokens| panic!("committed candidate must not be rewritten"),
            || Ok(journal.borrow().clone()),
            || {
                *journal.borrow_mut() = None;
                Ok(())
            },
        )
        .expect("exact Dropbox commit keeps the candidate and resolves the journal");
        finalize_staged_dropbox_credentials_in_store(
            &mut entries,
            "opaque-handle",
            "client-id",
            300,
        )
        .expect("committed first connection finalizes");

        assert!(journal.borrow().is_none());
        assert_eq!(
            read_active().expect("candidate remains active"),
            Some(candidate)
        );
        assert!(!entries.contains_key("opaque-handle"));
    }

    #[test]
    fn unknown_keyring_recovery_preserves_a_different_preexisting_bundle() {
        use std::cell::{Cell, RefCell};

        let candidate = test_dropbox_tokens("candidate", 100_000);
        let previous = test_dropbox_tokens("previous", 90_000);
        let journal_value = build_dropbox_promotion_journal_with_previous(
            DropboxPreviousCredentials::UnknownKeyring,
            &candidate,
        )
        .expect("build unknown-keyring journal");
        let journal = RefCell::new(Some(journal_value));
        let fallback = RefCell::new(Some(
            serde_json::to_string(&candidate).expect("serialize candidate fallback"),
        ));
        let keyring = RefCell::new(None::<String>);
        let keyring_available = Cell::new(false);
        let commit = RefCell::new(DropboxRecoveryCommitState {
            raw_backend: "off".to_string(),
            backend_marker: "off".to_string(),
            cloud_provider: "dropbox".to_string(),
            cloud_provider_authority: "native".to_string(),
        });

        let recover = || {
            recover_dropbox_credentials_fail_closed_with_commit_state(
                || Ok(commit.borrow().clone()),
                |backend| {
                    commit.borrow_mut().raw_backend = backend.to_string();
                    commit.borrow_mut().backend_marker = backend.to_string();
                    Ok(())
                },
                || {
                    read_dropbox_tokens_for_recovery_with(
                        || {
                            if keyring_available.get() {
                                Ok(keyring.borrow().clone())
                            } else {
                                Err("keyring unavailable".to_string())
                            }
                        },
                        || Ok(fallback.borrow().clone()),
                    )
                },
                |pending| {
                    resolve_unknown_dropbox_previous_credentials_with(pending, || {
                        if keyring_available.get() {
                            Ok(keyring.borrow().clone())
                        } else {
                            Err("keyring unavailable".to_string())
                        }
                    })
                },
                |tokens| {
                    let raw = tokens
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(|_| "serialize active tokens".to_string())?;
                    *keyring.borrow_mut() = raw;
                    *fallback.borrow_mut() = None;
                    Ok(())
                },
                || Ok(journal.borrow().clone()),
                || {
                    *journal.borrow_mut() = None;
                    Ok(())
                },
            )
        };

        recover().expect_err("unavailable prior keyring state remains pending and contained");
        assert!(journal.borrow().is_some());
        assert!(fallback.borrow().is_some());

        keyring_available.set(true);
        *keyring.borrow_mut() =
            Some(serde_json::to_string(&previous).expect("serialize previous keyring bundle"));
        recover().expect("available different keyring bundle is restored and verified");

        assert!(journal.borrow().is_none());
        assert!(fallback.borrow().is_none());
        assert_eq!(
            keyring
                .borrow()
                .as_deref()
                .map(parse_dropbox_token_bundle)
                .transpose()
                .expect("parse preserved keyring bundle"),
            Some(previous)
        );
    }

    #[test]
    fn unknown_keyring_resolution_preserves_even_an_exact_preexisting_candidate() {
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let previous = test_dropbox_tokens("previous", 90_000);
        let journal = build_dropbox_promotion_journal_with_previous(
            DropboxPreviousCredentials::UnknownKeyring,
            &candidate,
        )
        .expect("build unknown-keyring journal");

        assert_eq!(
            resolve_unknown_dropbox_previous_credentials_with(&journal, || {
                Ok(Some(
                    serde_json::to_string(&candidate).expect("serialize candidate"),
                ))
            })
            .expect("resolve partial candidate write"),
            DropboxPreviousCredentials::Bundle(candidate)
        );
        assert_eq!(
            resolve_unknown_dropbox_previous_credentials_with(&journal, || {
                Ok(Some(
                    serde_json::to_string(&previous).expect("serialize previous"),
                ))
            })
            .expect("resolve different prior bundle"),
            DropboxPreviousCredentials::Bundle(previous)
        );
        assert_eq!(
            resolve_unknown_dropbox_previous_credentials_with(&journal, || Ok(None))
                .expect("resolve known-empty keyring"),
            DropboxPreviousCredentials::Empty
        );
    }

    #[test]
    fn reconnect_crash_recovery_restores_previous_dropbox_credentials_while_sync_is_off() {
        use std::cell::RefCell;

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let active = RefCell::new(Some(candidate.clone()));
        let backend = RefCell::new("off".to_string());
        let journal = RefCell::new(Some(
            build_dropbox_promotion_journal(previous.clone(), &candidate)
                .expect("build promotion journal"),
        ));

        recover_dropbox_promotion_journal_with(
            || Ok(backend.borrow().clone()),
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            || Ok(journal.borrow().clone()),
            || {
                *journal.borrow_mut() = None;
                Ok(())
            },
        )
        .expect("off backend should roll a half-promoted reconnect back");

        assert_eq!(*active.borrow(), previous);
        assert!(journal.borrow().is_none());
        assert_eq!(backend.borrow().as_str(), "off");
    }

    #[test]
    fn first_connect_crash_recovery_restores_an_explicit_empty_credential_slot() {
        use std::cell::RefCell;

        let candidate = test_dropbox_tokens("candidate", 100_000);
        let active = RefCell::new(Some(candidate.clone()));
        let journal_value = build_dropbox_promotion_journal(None, &candidate)
            .expect("build first-connect promotion journal");
        let serialized = serde_json::to_string(&journal_value).expect("serialize journal");
        assert!(serialized.contains("\"kind\":\"empty\""));
        let journal = RefCell::new(Some(journal_value));

        recover_dropbox_promotion_journal_with(
            || Ok("off".to_string()),
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            || Ok(journal.borrow().clone()),
            || {
                *journal.borrow_mut() = None;
                Ok(())
            },
        )
        .expect("off backend should clear a half-promoted first connection");

        assert_eq!(*active.borrow(), None);
        assert!(journal.borrow().is_none());
    }

    #[test]
    fn committed_dropbox_crash_recovery_keeps_the_verified_candidate() {
        use std::cell::RefCell;

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let active = RefCell::new(Some(candidate.clone()));
        let journal = RefCell::new(Some(
            build_dropbox_promotion_journal(previous, &candidate).expect("build promotion journal"),
        ));

        recover_dropbox_promotion_journal_with(
            || Ok("cloud".to_string()),
            || Ok(active.borrow().clone()),
            |_tokens| panic!("committed candidate must not be replaced"),
            || Ok(journal.borrow().clone()),
            || {
                *journal.borrow_mut() = None;
                Ok(())
            },
        )
        .expect("cloud is the serialized transaction's committed Dropbox state");

        assert_eq!(*active.borrow(), Some(candidate));
        assert!(journal.borrow().is_none());
    }

    #[test]
    fn mismatched_committed_candidate_is_never_rolled_back_after_commit() {
        use std::cell::RefCell;

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let half_promoted = test_dropbox_tokens("half-promoted", 100_000);
        let active = RefCell::new(Some(half_promoted));
        let backend = RefCell::new("cloud".to_string());
        let journal = RefCell::new(Some(
            build_dropbox_promotion_journal(previous.clone(), &candidate)
                .expect("build promotion journal"),
        ));

        let error = recover_dropbox_credentials_fail_closed_with(
            || Ok(backend.borrow().clone()),
            |next| {
                *backend.borrow_mut() = next.to_string();
                Ok(())
            },
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            || Ok(journal.borrow().clone()),
            || {
                *journal.borrow_mut() = None;
                Ok(())
            },
        )
        .expect_err("a mismatched active bundle must be surfaced after fail-closed recovery");

        assert!(error.contains("active Dropbox commit was left intact"));
        assert_eq!(backend.borrow().as_str(), "cloud");
        assert_eq!(
            *active.borrow(),
            Some(test_dropbox_tokens("half-promoted", 100_000))
        );
        assert!(journal.borrow().is_some());
    }

    #[test]
    fn committed_journal_delete_uncertainty_never_triggers_post_commit_rollback() {
        use std::cell::{Cell, RefCell};

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let active = RefCell::new(Some(candidate.clone()));
        let backend = RefCell::new("cloud".to_string());
        let journal = RefCell::new(Some(
            build_dropbox_promotion_journal(previous.clone(), &candidate)
                .expect("build promotion journal"),
        ));
        let journal_reads = Cell::new(0usize);

        let error = recover_dropbox_credentials_fail_closed_with(
            || Ok(backend.borrow().clone()),
            |next| {
                *backend.borrow_mut() = next.to_string();
                Ok(())
            },
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            || {
                let read = journal_reads.get();
                journal_reads.set(read + 1);
                if read == 1 {
                    return Err("journal read-back unavailable".to_string());
                }
                Ok(journal.borrow().clone())
            },
            || {
                *journal.borrow_mut() = None;
                Ok(())
            },
        )
        .expect_err("uncertain journal deletion must be surfaced");

        assert!(error.contains("active Dropbox commit was left intact"));
        assert_eq!(backend.borrow().as_str(), "cloud");
        assert_eq!(*active.borrow(), Some(candidate));
    }

    #[test]
    fn portable_fallback_journal_supports_promotion_recovery_and_idempotent_clear() {
        use std::cell::{Cell, RefCell};

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let active = RefCell::new(previous.clone());
        let backend = RefCell::new("off".to_string());
        let fallback = RefCell::new(None::<String>);
        let active_writes = Cell::new(0usize);
        let keyring_write_attempts = Cell::new(0usize);
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            candidate.clone(),
            100,
        )
        .expect("stage portable candidate");

        let read_journal = || -> Result<Option<DropboxCredentialPromotionJournal>, String> {
            read_dropbox_promotion_journal_authority_with(
                || panic!("full fallback and tombstone reads do not classify orphan markers"),
                |payload| {
                    *fallback.borrow_mut() = Some(payload.to_string());
                    Ok(())
                },
                || Ok(fallback.borrow().clone()),
                || Ok(None),
                || Err("portable mode has no keyring".to_string()),
                || {
                    *fallback.borrow_mut() = None;
                    Ok(())
                },
            )
        };

        promote_staged_dropbox_credentials_with_journal(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || Ok(backend.borrow().clone()),
            || {
                Ok(DropboxPreviousCredentials::from_tokens(
                    active.borrow().clone(),
                ))
            },
            || Ok(active.borrow().clone()),
            |tokens| {
                active_writes.set(active_writes.get() + 1);
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            |tokens| {
                active_writes.set(active_writes.get() + 1);
                *active.borrow_mut() = Some(tokens.clone());
                Ok(())
            },
            read_journal,
            |journal| {
                write_dropbox_promotion_journal_authority_with(
                    journal,
                    |_payload| {
                        keyring_write_attempts.set(keyring_write_attempts.get() + 1);
                        Err("portable mode has no keyring".to_string())
                    },
                    |payload| {
                        *fallback.borrow_mut() = Some(payload.to_string());
                        Ok(())
                    },
                    || Ok(fallback.borrow().clone()),
                )
            },
        )
        .expect("portable fallback journal permits promotion");

        assert_eq!(*active.borrow(), Some(candidate));
        assert!(fallback.borrow().is_some());
        assert_eq!(keyring_write_attempts.get(), 1);

        recover_dropbox_promotion_journal_with(
            || Ok(backend.borrow().clone()),
            || Ok(active.borrow().clone()),
            |tokens| {
                active_writes.set(active_writes.get() + 1);
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            read_journal,
            || {
                logically_clear_dropbox_promotion_journal_with(
                    |payload| {
                        *fallback.borrow_mut() = Some(payload.to_string());
                        Ok(())
                    },
                    || Ok(fallback.borrow().clone()),
                    || Err("portable mode has no keyring".to_string()),
                    || Ok(None),
                    || {
                        *fallback.borrow_mut() = None;
                        Ok(())
                    },
                )
            },
        )
        .expect("portable crash recovery restores previous credentials");
        recover_dropbox_promotion_journal_with(
            || Ok(backend.borrow().clone()),
            || Ok(active.borrow().clone()),
            |_tokens| panic!("idempotent recovery must not rewrite active credentials"),
            read_journal,
            || panic!("idempotent recovery must not clear an absent journal"),
        )
        .expect("portable recovery is idempotent");

        assert_eq!(*active.borrow(), previous);
        assert!(matches!(
            parse_dropbox_promotion_journal_fallback_record(
                fallback.borrow().as_deref().expect("portable tombstone")
            )
            .expect("parse portable tombstone"),
            DropboxPromotionJournalFallbackRecord::Cleared { .. }
        ));
        assert_eq!(active_writes.get(), 2);
    }

    #[test]
    fn fallback_journal_and_tombstone_override_stale_keyring_state() {
        use std::cell::{Cell, RefCell};

        let authoritative = build_dropbox_promotion_journal(
            Some(test_dropbox_tokens("previous", 90_000)),
            &test_dropbox_tokens("candidate", 100_000),
        )
        .expect("build authoritative journal");
        let stale =
            build_dropbox_promotion_journal(None, &test_dropbox_tokens("stale-keyring", 110_000))
                .expect("build stale journal");
        let pending = serde_json::to_string(&DropboxPromotionJournalFallbackRecord::Pending {
            journal: authoritative.clone(),
        })
        .expect("serialize authoritative fallback");
        let keyring_reads = Cell::new(0usize);

        let selected = read_dropbox_promotion_journal_authority_with(
            || panic!("full fallback reads do not classify orphan markers"),
            |_payload| panic!("full pending fallback cannot be replaced while reading"),
            || Ok(Some(pending.clone())),
            || {
                keyring_reads.set(keyring_reads.get() + 1);
                Ok(Some(
                    serde_json::to_string(&stale).expect("serialize stale keyring"),
                ))
            },
            || panic!("pending fallback must not delete keyring before resolution"),
            || panic!("pending fallback must not be cleared before resolution"),
        )
        .expect("authoritative fallback is readable");
        assert_eq!(selected, Some(authoritative));
        assert_eq!(keyring_reads.get(), 0);

        let tombstone = serde_json::to_string(&DropboxPromotionJournalFallbackRecord::Cleared {
            version: DROPBOX_PROMOTION_JOURNAL_VERSION,
        })
        .expect("serialize tombstone");
        let fallback = RefCell::new(Some(tombstone));
        let selected = read_dropbox_promotion_journal_authority_with(
            || panic!("tombstone reads do not classify orphan markers"),
            |_payload| panic!("a tombstone must not be replaced while keyring is unavailable"),
            || Ok(fallback.borrow().clone()),
            || panic!("tombstone must be authoritative before keyring read"),
            || Err("keyring unavailable".to_string()),
            || panic!("tombstone must remain while keyring is uncertain"),
        )
        .expect("tombstone is a logical clear despite stale keyring uncertainty");
        assert!(selected.is_none());
        assert!(fallback.borrow().is_some());
    }

    #[test]
    fn tombstone_eventually_purges_stale_keyring_and_then_itself() {
        use std::cell::RefCell;

        let stale =
            build_dropbox_promotion_journal(None, &test_dropbox_tokens("stale-keyring", 110_000))
                .expect("build stale journal");
        let fallback = RefCell::new(Some(
            serde_json::to_string(&DropboxPromotionJournalFallbackRecord::Cleared {
                version: DROPBOX_PROMOTION_JOURNAL_VERSION,
            })
            .expect("serialize tombstone"),
        ));
        let keyring = RefCell::new(Some(
            serde_json::to_string(&stale).expect("serialize stale keyring"),
        ));

        let selected = read_dropbox_promotion_journal_authority_with(
            || panic!("tombstone reads do not classify orphan markers"),
            |_payload| panic!("a valid tombstone must not be replaced during cleanup"),
            || Ok(fallback.borrow().clone()),
            || Ok(keyring.borrow().clone()),
            || {
                *keyring.borrow_mut() = None;
                Ok(())
            },
            || {
                *fallback.borrow_mut() = None;
                Ok(())
            },
        )
        .expect("available keyring permits tombstone cleanup");

        assert!(selected.is_none());
        assert!(keyring.borrow().is_none());
        assert!(fallback.borrow().is_none());
    }

    #[test]
    fn tombstone_survives_false_positive_keyring_deletion() {
        use std::cell::RefCell;

        let stale =
            build_dropbox_promotion_journal(None, &test_dropbox_tokens("stale-keyring", 110_000))
                .expect("build stale journal");
        let fallback = RefCell::new(Some(
            serialize_dropbox_journal_tombstone().expect("serialize tombstone"),
        ));
        let keyring = serde_json::to_string(&stale).expect("serialize stale keyring");

        let selected = read_dropbox_promotion_journal_authority_with(
            || panic!("tombstone reads do not classify orphan markers"),
            |_payload| panic!("a valid tombstone must not be replaced during cleanup"),
            || Ok(fallback.borrow().clone()),
            || Ok(Some(keyring.clone())),
            // Some keyring backends can report success even though a later
            // read still returns stale bytes.
            || Ok(()),
            || panic!("unverified keyring deletion must retain the tombstone"),
        )
        .expect("the tombstone remains the logical authority");

        assert!(selected.is_none());
        assert!(matches!(
            parse_dropbox_promotion_journal_fallback_record(
                fallback.borrow().as_deref().expect("retained tombstone")
            )
            .expect("parse tombstone"),
            DropboxPromotionJournalFallbackRecord::Cleared { .. }
        ));
    }

    #[test]
    fn healthy_keyring_journal_does_not_duplicate_pending_secrets_in_fallback() {
        use std::cell::RefCell;

        let journal = build_dropbox_promotion_journal(
            Some(test_dropbox_tokens("previous", 90_000)),
            &test_dropbox_tokens("candidate", 100_000),
        )
        .expect("build journal");
        let keyring = RefCell::new(None::<String>);
        let fallback = RefCell::new(Some(
            serialize_dropbox_journal_tombstone().expect("serialize old tombstone"),
        ));

        write_dropbox_promotion_journal_authority_with(
            &journal,
            |payload| {
                *keyring.borrow_mut() = Some(payload.to_string());
                let persisted = keyring.borrow().clone().expect("keyring payload");
                let parsed: DropboxCredentialPromotionJournal =
                    serde_json::from_str(&persisted).expect("parse keyring journal");
                if parsed != journal {
                    return Err("keyring read-back mismatch".to_string());
                }
                Ok(())
            },
            |payload| {
                assert!(
                    !payload.contains("previous-access")
                        && !payload.contains("previous-refresh")
                        && !payload.contains("candidate-access")
                        && !payload.contains("candidate-refresh"),
                    "healthy keyring fallback must remain a redacted marker"
                );
                *fallback.borrow_mut() = Some(payload.to_string());
                Ok(())
            },
            || Ok(fallback.borrow().clone()),
        )
        .expect("verified keyring write succeeds without fallback duplication");

        assert!(matches!(
            parse_dropbox_promotion_journal_fallback_record(
                fallback
                    .borrow()
                    .as_deref()
                    .expect("pending keyring marker")
            )
            .expect("parse pending keyring marker"),
            DropboxPromotionJournalFallbackRecord::PendingKeyring { .. }
        ));
        assert!(keyring
            .borrow()
            .as_deref()
            .expect("keyring journal")
            .contains("previous-access"));
        assert_eq!(
            read_dropbox_promotion_journal_authority_with(
                || Ok(false),
                |_payload| panic!("matching marker must remain stable"),
                || Ok(fallback.borrow().clone()),
                || Ok(keyring.borrow().clone()),
                || panic!("matching marker must not delete the keyring journal"),
                || panic!("matching marker must not be removed before resolution"),
            )
            .expect("transaction-bound marker selects its keyring journal"),
            Some(journal)
        );
    }

    #[test]
    fn stale_redacted_marker_stops_before_keyring_or_candidate_publication() {
        use std::cell::Cell;

        let journal = build_dropbox_promotion_journal(
            Some(test_dropbox_tokens("previous", 90_000)),
            &test_dropbox_tokens("candidate", 100_000),
        )
        .expect("build current journal");
        let stale_journal = build_dropbox_promotion_journal(
            Some(test_dropbox_tokens("older-previous", 80_000)),
            &test_dropbox_tokens("older-candidate", 95_000),
        )
        .expect("build stale journal");
        let stale_marker = serialize_dropbox_pending_keyring_marker(&stale_journal)
            .expect("serialize stale marker");
        let keyring_writes = Cell::new(0usize);

        let error = write_dropbox_promotion_journal_authority_with(
            &journal,
            |_payload| {
                keyring_writes.set(keyring_writes.get() + 1);
                Ok(())
            },
            |_payload| Ok(()),
            || Ok(Some(stale_marker.clone())),
        )
        .expect_err("a stale marker cannot authorize the current transaction");

        assert!(error.contains("does not match the pending transaction"));
        assert_eq!(keyring_writes.get(), 0);
    }

    #[test]
    fn clean_profile_without_marker_never_reads_an_unavailable_keyring() {
        for backend in ["off", "file", "webdav", "cloudkit", "cloud"] {
            use std::cell::Cell;

            let backend_writes = Cell::new(0usize);
            recover_dropbox_credentials_fail_closed_with(
                || Ok(backend.to_string()),
                |_next| {
                    backend_writes.set(backend_writes.get() + 1);
                    Ok(())
                },
                || panic!("clean startup must not inspect active Dropbox credentials"),
                |_tokens| panic!("clean startup must not mutate active Dropbox credentials"),
                || {
                    read_dropbox_promotion_journal_authority_with(
                        || panic!("an absent marker is not an orphan"),
                        |_payload| panic!("clean startup must not write fallback state"),
                        || Ok(None),
                        || panic!("absent fallback must not touch the keyring"),
                        || panic!("absent fallback must not delete keyring state"),
                        || panic!("absent fallback must not be cleared"),
                    )
                },
                || panic!("clean startup has no journal to clear"),
            )
            .expect("clean startup is a no-op even without a keyring service");
            assert_eq!(
                backend_writes.get(),
                0,
                "backend {backend} must be preserved"
            );
        }
    }

    #[test]
    fn pending_keyring_marker_outage_fails_closed_instead_of_looking_clean() {
        let journal =
            build_dropbox_promotion_journal(None, &test_dropbox_tokens("candidate", 100_000))
                .expect("build journal");
        let marker = serialize_dropbox_pending_keyring_marker(&journal).expect("serialize marker");

        let error = read_dropbox_promotion_journal_authority_with(
            || Ok(false),
            |_payload| panic!("unavailable keyring must retain the marker"),
            || Ok(Some(marker.clone())),
            || Err("keyring unavailable".to_string()),
            || panic!("unavailable keyring must not be deleted"),
            || panic!("unavailable keyring must retain the marker"),
        )
        .expect_err("a pending marker makes keyring availability mandatory");
        assert!(error.contains("Failed to inspect"));
    }

    #[test]
    fn transaction_bound_marker_never_recovers_a_stale_keyring_journal() {
        use std::cell::RefCell;

        let old = build_dropbox_promotion_journal(
            Some(test_dropbox_tokens("old-previous", 80_000)),
            &test_dropbox_tokens("old-candidate", 90_000),
        )
        .expect("build stale journal");
        let next = build_dropbox_promotion_journal(
            Some(test_dropbox_tokens("next-previous", 100_000)),
            &test_dropbox_tokens("next-candidate", 110_000),
        )
        .expect("build new journal");
        let fallback = RefCell::new(Some(
            serialize_dropbox_pending_keyring_marker(&next).expect("serialize new marker"),
        ));
        let keyring = RefCell::new(Some(
            serde_json::to_string(&old).expect("serialize stale keyring journal"),
        ));

        let selected = read_dropbox_promotion_journal_authority_with(
            || Ok(true),
            |payload| {
                *fallback.borrow_mut() = Some(payload.to_string());
                Ok(())
            },
            || Ok(fallback.borrow().clone()),
            || Ok(keyring.borrow().clone()),
            || {
                *keyring.borrow_mut() = None;
                Ok(())
            },
            || {
                *fallback.borrow_mut() = None;
                Ok(())
            },
        )
        .expect("off-state orphan cleanup discards the stale journal");

        assert!(selected.is_none());
        assert!(keyring.borrow().is_none());
        assert!(fallback.borrow().is_none());
    }

    #[test]
    fn new_pending_fallback_replaces_a_cleared_tombstone_during_keyring_outage() {
        use std::cell::RefCell;

        let journal =
            build_dropbox_promotion_journal(None, &test_dropbox_tokens("candidate", 100_000))
                .expect("build journal");
        let fallback = RefCell::new(Some(
            serialize_dropbox_journal_tombstone().expect("serialize old tombstone"),
        ));

        write_dropbox_promotion_journal_authority_with(
            &journal,
            |_payload| Err("keyring unavailable".to_string()),
            |payload| {
                *fallback.borrow_mut() = Some(payload.to_string());
                Ok(())
            },
            || Ok(fallback.borrow().clone()),
        )
        .expect("a new transaction replaces the redacted tombstone");

        assert_eq!(
            read_dropbox_promotion_journal_authority_with(
                || panic!("full fallback reads do not classify orphan markers"),
                |_payload| panic!("full pending fallback cannot be replaced while reading"),
                || Ok(fallback.borrow().clone()),
                || panic!("pending fallback must be authoritative"),
                || panic!("pending fallback must not clear keyring state"),
                || panic!("pending fallback must not be removed"),
            )
            .expect("read replacement pending journal"),
            Some(journal)
        );
    }

    #[test]
    fn logical_clear_is_crash_safe_before_and_after_redacted_tombstone() {
        use std::cell::RefCell;

        let journal = build_dropbox_promotion_journal(
            Some(test_dropbox_tokens("previous", 90_000)),
            &test_dropbox_tokens("candidate", 100_000),
        )
        .expect("build journal");
        let pending = serde_json::to_string(&DropboxPromotionJournalFallbackRecord::Pending {
            journal: journal.clone(),
        })
        .expect("serialize pending fallback");
        let fallback = RefCell::new(Some(pending.clone()));

        logically_clear_dropbox_promotion_journal_with(
            |_payload| Err("crash before tombstone publish".to_string()),
            || Ok(fallback.borrow().clone()),
            || panic!("keyring deletion cannot precede the tombstone"),
            || panic!("keyring read cannot precede the tombstone"),
            || panic!("fallback clear cannot precede the tombstone"),
        )
        .expect_err("failed tombstone publication must preserve pending recovery");
        assert_eq!(fallback.borrow().as_deref(), Some(pending.as_str()));

        logically_clear_dropbox_promotion_journal_with(
            |payload| {
                *fallback.borrow_mut() = Some(payload.to_string());
                Ok(())
            },
            || Ok(fallback.borrow().clone()),
            || Err("crash after tombstone publish".to_string()),
            || panic!("failed keyring deletion cannot be verified"),
            || panic!("uncertain keyring must retain the tombstone"),
        )
        .expect("published tombstone completes logical clear");
        let tombstone = fallback.borrow().clone().expect("retained tombstone");
        assert!(!tombstone.contains("previous-access"));
        assert!(!tombstone.contains("previous-refresh"));
        assert!(!tombstone.contains("candidate-access"));
        assert!(!tombstone.contains("candidate-refresh"));

        let selected = read_dropbox_promotion_journal_authority_with(
            || panic!("tombstone reads do not classify orphan markers"),
            |_payload| {
                panic!("published tombstone must not be replaced while keyring is unavailable")
            },
            || Ok(fallback.borrow().clone()),
            || panic!("tombstone masks a stale keyring"),
            || Err("keyring still unavailable".to_string()),
            || panic!("uncertain keyring must retain the tombstone"),
        )
        .expect("startup honors the published tombstone");
        assert!(selected.is_none());
    }

    #[test]
    fn strict_journal_purge_retains_tombstone_until_keyring_deletion_is_verified() {
        use std::cell::RefCell;

        let journal = build_dropbox_promotion_journal(
            Some(test_dropbox_tokens("previous", 90_000)),
            &test_dropbox_tokens("candidate", 100_000),
        )
        .expect("build journal");
        let fallback = RefCell::new(Some(
            serde_json::to_string(&DropboxPromotionJournalFallbackRecord::Pending { journal })
                .expect("serialize pending fallback"),
        ));

        strictly_purge_dropbox_promotion_journal_with(
            true,
            |payload| {
                *fallback.borrow_mut() = Some(payload.to_string());
                Ok(())
            },
            || Ok(fallback.borrow().clone()),
            || Err("keyring deletion unavailable".to_string()),
            || panic!("failed keyring deletion cannot be verified"),
            || {
                *fallback.borrow_mut() = None;
                Ok(())
            },
        )
        .expect_err("strict disconnect cannot accept uncertain keyring deletion");
        let retained = fallback.borrow().clone().expect("retained tombstone");
        assert!(matches!(
            serde_json::from_str::<DropboxPromotionJournalFallbackRecord>(&retained)
                .expect("parse retained tombstone"),
            DropboxPromotionJournalFallbackRecord::Cleared { .. }
        ));
        assert!(!retained.contains("access"));
        assert!(!retained.contains("refresh"));

        strictly_purge_dropbox_promotion_journal_with(
            true,
            |payload| {
                *fallback.borrow_mut() = Some(payload.to_string());
                Ok(())
            },
            || Ok(fallback.borrow().clone()),
            || Ok(()),
            || Ok(None),
            || {
                *fallback.borrow_mut() = None;
                Ok(())
            },
        )
        .expect("verified keyring deletion permits physical fallback purge");
        assert!(fallback.borrow().is_none());
    }

    #[test]
    fn strict_journal_purge_rejects_false_positive_keyring_deletion() {
        use std::cell::RefCell;

        let fallback = RefCell::new(None::<String>);
        let stale = serialize_dropbox_pending_journal_fallback(
            &build_dropbox_promotion_journal(None, &test_dropbox_tokens("stale-keyring", 110_000))
                .expect("build stale journal"),
        )
        .expect("serialize stale keyring");

        strictly_purge_dropbox_promotion_journal_with(
            true,
            |payload| {
                *fallback.borrow_mut() = Some(payload.to_string());
                Ok(())
            },
            || Ok(fallback.borrow().clone()),
            || Ok(()),
            || Ok(Some(stale.clone())),
            || panic!("fallback cannot be removed before keyring absence is verified"),
        )
        .expect_err("stale read-back invalidates a successful delete result");

        assert!(matches!(
            parse_dropbox_promotion_journal_fallback_record(
                fallback.borrow().as_deref().expect("retained tombstone")
            )
            .expect("parse retained tombstone"),
            DropboxPromotionJournalFallbackRecord::Cleared { .. }
        ));
    }

    #[test]
    fn strict_journal_purge_restores_tombstone_if_keyring_recheck_becomes_uncertain() {
        use std::cell::{Cell, RefCell};

        let fallback = RefCell::new(None::<String>);
        let keyring_reads = Cell::new(0usize);

        strictly_purge_dropbox_promotion_journal_with(
            true,
            |payload| {
                *fallback.borrow_mut() = Some(payload.to_string());
                Ok(())
            },
            || Ok(fallback.borrow().clone()),
            || Ok(()),
            || {
                let read = keyring_reads.get();
                keyring_reads.set(read + 1);
                if read == 0 {
                    Ok(None)
                } else {
                    Err("keyring became unavailable".to_string())
                }
            },
            || {
                *fallback.borrow_mut() = None;
                Ok(())
            },
        )
        .expect_err("the post-removal keyring recheck is required");

        assert_eq!(keyring_reads.get(), 2);
        assert!(matches!(
            parse_dropbox_promotion_journal_fallback_record(
                fallback.borrow().as_deref().expect("restored tombstone")
            )
            .expect("parse restored tombstone"),
            DropboxPromotionJournalFallbackRecord::Cleared { .. }
        ));
    }

    #[test]
    fn journal_is_verified_before_active_credentials_are_overwritten() {
        use std::cell::RefCell;

        let events = RefCell::new(Vec::<&'static str>::new());
        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let active = RefCell::new(previous.clone());
        let journal = RefCell::new(None::<DropboxCredentialPromotionJournal>);
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            candidate,
            100,
        )
        .expect("stage candidate");

        promote_staged_dropbox_credentials_with_journal(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || {
                events.borrow_mut().push("read-backend-off");
                Ok("off".to_string())
            },
            || {
                events.borrow_mut().push("read-active");
                Ok(DropboxPreviousCredentials::from_tokens(
                    active.borrow().clone(),
                ))
            },
            || {
                events.borrow_mut().push("read-active");
                Ok(active.borrow().clone())
            },
            |tokens| {
                events.borrow_mut().push("write-active");
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            |_tokens| panic!("known previous credentials use the verified active writer"),
            || {
                events.borrow_mut().push("read-journal");
                Ok(journal.borrow().clone())
            },
            |next| {
                events.borrow_mut().push("write-journal");
                *journal.borrow_mut() = Some(next.clone());
                Ok(())
            },
        )
        .expect("journaled promotion");

        let events = events.borrow();
        let journal_write = events
            .iter()
            .position(|event| *event == "write-journal")
            .expect("journal write event");
        let active_write = events
            .iter()
            .position(|event| *event == "write-active")
            .expect("active write event");
        assert!(journal_write < active_write);
        assert!(events[..active_write].contains(&"read-journal"));
        assert!(events[..active_write].contains(&"read-backend-off"));
        assert_eq!(
            journal.borrow().as_ref().unwrap().previous.cloned_tokens(),
            previous
        );
    }

    #[test]
    fn backend_publication_before_the_second_promotion_guard_prevents_active_write() {
        use std::cell::{Cell, RefCell};

        let backend_reads = Cell::new(0usize);
        let active_writes = Cell::new(0usize);
        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let active = RefCell::new(previous.clone());
        let journal = RefCell::new(None::<DropboxCredentialPromotionJournal>);
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            test_dropbox_tokens("candidate", 100_000),
            100,
        )
        .expect("stage candidate");

        let error = promote_staged_dropbox_credentials_with_journal(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || {
                let read = backend_reads.get();
                backend_reads.set(read + 1);
                let state = if read == 0 {
                    DropboxRecoveryCommitState {
                        raw_backend: "off".to_string(),
                        backend_marker: "off".to_string(),
                        cloud_provider: "dropbox".to_string(),
                        cloud_provider_authority: "native".to_string(),
                    }
                } else {
                    // Models a concurrent atomic publication completing before
                    // the second guard immediately ahead of credential write.
                    DropboxRecoveryCommitState {
                        raw_backend: "cloud".to_string(),
                        backend_marker: "cloud".to_string(),
                        cloud_provider: "dropbox".to_string(),
                        cloud_provider_authority: "native".to_string(),
                    }
                };
                require_durably_disabled_dropbox_backend(state)
            },
            || {
                Ok(DropboxPreviousCredentials::from_tokens(
                    active.borrow().clone(),
                ))
            },
            || Ok(active.borrow().clone()),
            |_tokens| {
                active_writes.set(active_writes.get() + 1);
                Ok(())
            },
            |_tokens| panic!("known previous credentials use the active writer"),
            || Ok(journal.borrow().clone()),
            |next| {
                *journal.borrow_mut() = Some(next.clone());
                Ok(())
            },
        )
        .expect_err("committed cloud backend must stop candidate promotion");

        assert!(error.contains("durably disabled"));
        assert_eq!(backend_reads.get(), 2);
        assert_eq!(active_writes.get(), 0);
        assert_eq!(*active.borrow(), previous);
        assert!(journal.borrow().is_some());
        assert!(matches!(
            entries.get("opaque-handle").map(|entry| &entry.phase),
            Some(DropboxStagedCredentialPhase::Candidate)
        ));
    }

    #[test]
    fn startup_recovery_only_continues_after_fail_closed_state_is_verified() {
        assert_eq!(
            classify_dropbox_startup_recovery_with(Ok(()), || {
                panic!("clean recovery needs no containment read")
            })
            .expect("clean startup"),
            DropboxStartupRecoveryOutcome::Ready
        );
        assert!(matches!(
            classify_dropbox_startup_recovery_with(Err("recovery warning".to_string()), || Ok(
                "off".to_string()
            ),)
            .expect("verified off is safe containment"),
            DropboxStartupRecoveryOutcome::SyncDisabled { .. }
        ));
        let not_disabled = classify_dropbox_startup_recovery_with(
            Err("recovery warning".to_string()),
            || Ok("cloud".to_string()),
        )
        .expect_err("non-off backend must fail closed");
        assert!(not_disabled.contains("recovery warning"));
        assert!(not_disabled.contains("cloud"));
        let unverified = classify_dropbox_startup_recovery_with(
            Err("recovery warning".to_string()),
            || Err("backend unreadable".to_string()),
        )
        .expect_err("unreadable state must fail closed");
        assert!(unverified.contains("backend unreadable"));
        assert!(unverified.contains("recovery warning"));
    }

    #[test]
    fn journal_persistence_failure_never_overwrites_active_credentials() {
        use std::cell::{Cell, RefCell};

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let active = RefCell::new(previous.clone());
        let active_writes = Cell::new(0usize);
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            test_dropbox_tokens("candidate", 100_000),
            100,
        )
        .expect("stage candidate");

        let error = promote_staged_dropbox_credentials_with_journal(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || Ok("off".to_string()),
            || {
                Ok(DropboxPreviousCredentials::from_tokens(
                    active.borrow().clone(),
                ))
            },
            || Ok(active.borrow().clone()),
            |_tokens| {
                active_writes.set(active_writes.get() + 1);
                Ok(())
            },
            |_tokens| panic!("journal failure stops before candidate fallback publication"),
            || panic!("failed journal write must stop before journal read-back"),
            |_journal| Err("journal keyring and fallback unavailable".to_string()),
        )
        .expect_err("promotion requires a durable recovery journal");

        assert!(error.contains("journal keyring and fallback unavailable"));
        assert_eq!(*active.borrow(), previous);
        assert_eq!(active_writes.get(), 0);
        assert!(matches!(
            entries.get("opaque-handle").map(|entry| &entry.phase),
            Some(DropboxStagedCredentialPhase::Candidate)
        ));
    }

    #[test]
    fn unreadable_journal_leaves_an_exact_committed_backend_intact() {
        use std::cell::RefCell;

        let candidate = Some(test_dropbox_tokens("candidate", 100_000));
        let active = RefCell::new(candidate.clone());
        let backend = RefCell::new("cloud".to_string());
        let error = recover_dropbox_credentials_fail_closed_with(
            || Ok(backend.borrow().clone()),
            |next| {
                *backend.borrow_mut() = next.to_string();
                Ok(())
            },
            || panic!("an unreadable journal has no trustworthy active expectation"),
            |_tokens| panic!("an unreadable journal must not rewrite active credentials"),
            || Err("journal keyring unavailable".to_string()),
            || panic!("an unreadable journal must not be cleared"),
        )
        .expect_err("journal uncertainty is surfaced");

        assert!(error.contains("active Dropbox commit was left intact"));
        assert_eq!(backend.borrow().as_str(), "cloud");
        assert_eq!(*active.borrow(), candidate);
    }

    #[test]
    fn unreadable_journal_and_commit_state_leave_recovery_state_untouched() {
        use std::cell::Cell;

        let commit_reads = Cell::new(0usize);
        let backend_writes = Cell::new(0usize);
        let active_reads = Cell::new(0usize);
        let previous_resolutions = Cell::new(0usize);
        let active_writes = Cell::new(0usize);
        let journal_reads = Cell::new(0usize);
        let journal_clears = Cell::new(0usize);

        let error = recover_dropbox_credentials_fail_closed_with_commit_state(
            || {
                commit_reads.set(commit_reads.get() + 1);
                Err("private commit state keyring failure".to_string())
            },
            |_backend| {
                backend_writes.set(backend_writes.get() + 1);
                Ok(())
            },
            || {
                active_reads.set(active_reads.get() + 1);
                Ok(None)
            },
            |_journal| {
                previous_resolutions.set(previous_resolutions.get() + 1);
                Ok(DropboxPreviousCredentials::Empty)
            },
            |_tokens| {
                active_writes.set(active_writes.get() + 1);
                Ok(())
            },
            || {
                journal_reads.set(journal_reads.get() + 1);
                Err("private journal keyring failure".to_string())
            },
            || {
                journal_clears.set(journal_clears.get() + 1);
                Ok(())
            },
        )
        .expect_err("commit-state uncertainty must remain retryable and non-mutating");

        assert!(error.contains("could not verify the durable sync commit state"));
        assert!(!error.contains("private commit state keyring failure"));
        assert!(!error.contains("private journal keyring failure"));
        assert_eq!(commit_reads.get(), 1);
        assert_eq!(journal_reads.get(), 1);
        assert_eq!(backend_writes.get(), 0);
        assert_eq!(active_reads.get(), 0);
        assert_eq!(previous_resolutions.get(), 0);
        assert_eq!(active_writes.get(), 0);
        assert_eq!(journal_clears.get(), 0);
    }

    #[test]
    fn known_journal_and_unreadable_commit_state_leave_recovery_state_untouched() {
        use std::cell::Cell;

        let candidate = test_dropbox_tokens("candidate", 100_000);
        let journal = build_dropbox_promotion_journal(
            Some(test_dropbox_tokens("previous", 90_000)),
            &candidate,
        )
        .expect("build recovery journal");
        let commit_reads = Cell::new(0usize);
        let backend_writes = Cell::new(0usize);
        let active_reads = Cell::new(0usize);
        let previous_resolutions = Cell::new(0usize);
        let active_writes = Cell::new(0usize);
        let journal_reads = Cell::new(0usize);
        let journal_clears = Cell::new(0usize);

        let error = recover_dropbox_credentials_fail_closed_with_commit_state(
            || {
                commit_reads.set(commit_reads.get() + 1);
                Err("private commit state config failure".to_string())
            },
            |_backend| {
                backend_writes.set(backend_writes.get() + 1);
                Ok(())
            },
            || {
                active_reads.set(active_reads.get() + 1);
                Ok(Some(candidate.clone()))
            },
            |_journal| {
                previous_resolutions.set(previous_resolutions.get() + 1);
                Ok(DropboxPreviousCredentials::Empty)
            },
            |_tokens| {
                active_writes.set(active_writes.get() + 1);
                Ok(())
            },
            || {
                journal_reads.set(journal_reads.get() + 1);
                Ok(Some(journal.clone()))
            },
            || {
                journal_clears.set(journal_clears.get() + 1);
                Ok(())
            },
        )
        .expect_err("commit-state uncertainty must stop before recovery mutation");

        assert!(error.contains("could not verify the durable sync commit state"));
        assert!(!error.contains("private commit state config failure"));
        assert_eq!(commit_reads.get(), 1);
        assert_eq!(journal_reads.get(), 1);
        assert_eq!(backend_writes.get(), 0);
        assert_eq!(active_reads.get(), 0);
        assert_eq!(previous_resolutions.get(), 0);
        assert_eq!(active_writes.get(), 0);
        assert_eq!(journal_clears.get(), 0);
    }

    #[test]
    fn journal_clear_failure_keeps_recovery_pending_and_retryable() {
        use std::cell::{Cell, RefCell};

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let active = RefCell::new(Some(candidate.clone()));
        let backend = RefCell::new("off".to_string());
        let journal = RefCell::new(Some(
            build_dropbox_promotion_journal(previous.clone(), &candidate).expect("build journal"),
        ));
        let fail_clear = Cell::new(true);

        let error = recover_dropbox_credentials_fail_closed_with(
            || Ok(backend.borrow().clone()),
            |next| {
                *backend.borrow_mut() = next.to_string();
                Ok(())
            },
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            || Ok(journal.borrow().clone()),
            || {
                if fail_clear.get() {
                    return Err("journal deletion unavailable".to_string());
                }
                *journal.borrow_mut() = None;
                Ok(())
            },
        )
        .expect_err("uncleared journal remains a surfaced recovery condition");
        assert!(error.contains("recovery remains pending"));
        assert_eq!(*active.borrow(), previous);
        assert!(journal.borrow().is_some());
        assert_eq!(backend.borrow().as_str(), "off");

        fail_clear.set(false);
        recover_dropbox_credentials_fail_closed_with(
            || Ok(backend.borrow().clone()),
            |next| {
                *backend.borrow_mut() = next.to_string();
                Ok(())
            },
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            || Ok(journal.borrow().clone()),
            || {
                *journal.borrow_mut() = None;
                Ok(())
            },
        )
        .expect("recovery retries idempotently once journal deletion is available");
        assert_eq!(*active.borrow(), previous);
        assert!(journal.borrow().is_none());
    }

    #[test]
    fn recovery_errors_never_include_journaled_token_bytes() {
        use std::cell::RefCell;

        let previous = Some(DropboxTokenBundle {
            client_id: "private-client-id".to_string(),
            access_token: "private-previous-access".to_string(),
            refresh_token: "private-previous-refresh".to_string(),
            expires_at: 90_000,
        });
        let candidate = DropboxTokenBundle {
            client_id: "private-client-id".to_string(),
            access_token: "private-candidate-access".to_string(),
            refresh_token: "private-candidate-refresh".to_string(),
            expires_at: 100_000,
        };
        let journal = build_dropbox_promotion_journal(previous.clone(), &candidate)
            .expect("build private journal");
        let active = RefCell::new(Some(test_dropbox_tokens("mismatch", 100_000)));
        let backend = RefCell::new("cloud".to_string());

        let error = recover_dropbox_credentials_fail_closed_with(
            || Ok(backend.borrow().clone()),
            |next| {
                *backend.borrow_mut() = next.to_string();
                Ok(())
            },
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            || Ok(Some(journal.clone())),
            || Ok(()),
        )
        .expect_err("mismatch is surfaced after safe containment");

        for secret in [
            "private-client-id",
            "private-previous-access",
            "private-previous-refresh",
            "private-candidate-access",
            "private-candidate-refresh",
        ] {
            assert!(!error.contains(secret), "recovery error leaked {secret}");
        }
    }

    #[test]
    fn staged_dropbox_refresh_updates_only_the_transient_candidate() {
        let mut entries = HashMap::new();
        let old_active = test_dropbox_tokens("old-active", 99_000);
        let candidate = test_dropbox_tokens("candidate", 1);
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            candidate,
            100,
        )
        .expect("stage candidate");

        let access_token = resolve_staged_dropbox_access_token_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            true,
            200,
            |_client_id, refresh_token| {
                assert_eq!(refresh_token, "candidate-refresh");
                Ok(("candidate-refreshed-access".to_string(), 200_000))
            },
        )
        .expect("refresh staged candidate");

        assert_eq!(access_token, "candidate-refreshed-access");
        assert_eq!(old_active.access_token, "old-active-access");
        assert_eq!(
            entries
                .get("opaque-handle")
                .expect("staged candidate")
                .tokens
                .access_token,
            "candidate-refreshed-access"
        );
    }

    #[test]
    fn promoted_dropbox_candidate_can_restore_the_previous_account() {
        use std::cell::RefCell;

        let mut entries = HashMap::new();
        let old_active = test_dropbox_tokens("old-active", 99_000);
        let candidate = test_dropbox_tokens("candidate", 100_000);
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            candidate.clone(),
            100,
        )
        .expect("stage candidate");
        let active = RefCell::new(Some(old_active.clone()));

        promote_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
        )
        .expect("promote candidate");
        assert_eq!(*active.borrow(), Some(candidate));

        rollback_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            300,
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
        )
        .expect("restore previous account");

        assert_eq!(*active.borrow(), Some(old_active));
        assert!(!entries.contains_key("opaque-handle"));
    }

    #[test]
    fn promotion_readback_mismatch_restores_old_tokens_and_keeps_candidate_staged() {
        use std::cell::RefCell;

        let mut entries = HashMap::new();
        let old_active = test_dropbox_tokens("old-active", 99_000);
        let candidate = test_dropbox_tokens("candidate", 100_000);
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            candidate,
            100,
        )
        .expect("stage candidate");
        let active = RefCell::new(Some(old_active.clone()));
        let reads = RefCell::new(0usize);

        let error = promote_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || {
                let mut reads = reads.borrow_mut();
                *reads += 1;
                if *reads == 2 {
                    return Ok(Some(test_dropbox_tokens("wrong-readback", 100_000)));
                }
                Ok(active.borrow().clone())
            },
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
        )
        .expect_err("mismatched durable readback must fail");

        assert!(error.contains("read-back"), "unexpected error: {error}");
        assert_eq!(*active.borrow(), Some(old_active));
        assert!(matches!(
            entries.get("opaque-handle").map(|entry| &entry.phase),
            Some(DropboxStagedCredentialPhase::Candidate)
        ));
    }

    #[test]
    fn dropbox_failed_promotion_restore_retains_rollback_state() {
        use std::cell::RefCell;

        let mut entries = HashMap::new();
        let old_active = test_dropbox_tokens("old-active", 99_000);
        let candidate = test_dropbox_tokens("candidate", 100_000);
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            candidate.clone(),
            100,
        )
        .expect("stage candidate");
        let active = RefCell::new(Some(old_active.clone()));
        let reads = RefCell::new(0usize);
        let writes = RefCell::new(0usize);

        let error = promote_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || {
                let mut reads = reads.borrow_mut();
                *reads += 1;
                if *reads == 2 {
                    return Ok(Some(test_dropbox_tokens("wrong-readback", 100_000)));
                }
                Ok(active.borrow().clone())
            },
            |tokens| {
                let mut writes = writes.borrow_mut();
                *writes += 1;
                if *writes == 2 {
                    return Err("keyring unavailable".to_string());
                }
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
        )
        .expect_err("failed restoration must fail promotion");

        assert!(error.contains("could not be restored"));
        assert_eq!(*active.borrow(), Some(candidate));
        assert!(matches!(
            entries.get("opaque-handle").map(|entry| &entry.phase),
            Some(DropboxStagedCredentialPhase::Promoted { .. })
        ));

        rollback_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            300,
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
        )
        .expect("later rollback can still restore the previous credentials");
        assert_eq!(*active.borrow(), Some(old_active));
    }

    #[test]
    fn dropbox_staged_handles_are_client_bound_and_expire() {
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            test_dropbox_tokens("candidate", 999_999_999),
            100,
        )
        .expect("stage candidate");

        let wrong_client = resolve_staged_dropbox_access_token_with(
            &mut entries,
            "opaque-handle",
            "other-client",
            false,
            200,
            |_client_id, _refresh_token| panic!("wrong-client lookup must not refresh"),
        )
        .expect_err("handle must be bound to its app key");
        assert!(wrong_client.contains("different app key"));

        let expired = resolve_staged_dropbox_access_token_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            false,
            100 + DROPBOX_STAGED_CREDENTIAL_TTL_MS + 1,
            |_client_id, _refresh_token| panic!("expired handle must not refresh"),
        )
        .expect_err("expired handle must be rejected");
        assert!(expired.contains("invalid or expired"));
        assert!(!entries.contains_key("opaque-handle"));
    }

    #[test]
    fn expired_candidate_discard_is_idempotent_while_the_backend_remains_active() {
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            test_dropbox_tokens("candidate", 999_999_999),
            100,
        )
        .expect("stage candidate");

        // Candidate discard has no durable credential side effect, so an
        // already-active backend must not turn expiration cleanup into a wedge.
        discard_staged_dropbox_credentials_in_store(
            &mut entries,
            "opaque-handle",
            "client-id",
            100 + DROPBOX_STAGED_CREDENTIAL_TTL_MS + 1,
        )
        .expect("discarding an already-pruned candidate is idempotent");
        assert!(!entries.contains_key("opaque-handle"));
    }

    #[test]
    fn failed_reconnect_candidate_discard_leaves_active_credentials_untouched() {
        let mut entries = HashMap::new();
        let active = Some(test_dropbox_tokens("active", 90_000));
        let journal = Some("durable-journal-sentinel".to_string());
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            test_dropbox_tokens("candidate", 100_000),
            100,
        )
        .expect("stage reconnect candidate");

        discard_staged_dropbox_credentials_in_store(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
        )
        .expect("failed reconnect candidate is memory-only and discardable");

        assert_eq!(active, Some(test_dropbox_tokens("active", 90_000)));
        assert_eq!(journal.as_deref(), Some("durable-journal-sentinel"));
        assert!(!entries.contains_key("opaque-handle"));
    }

    #[test]
    fn promoted_handle_is_not_ttl_pruned_and_remains_rollbackable() {
        use std::cell::RefCell;

        let mut entries = HashMap::new();
        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let active = RefCell::new(previous.clone());
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            candidate,
            100,
        )
        .expect("stage candidate");
        promote_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
        )
        .expect("promote candidate");

        rollback_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            100 + DROPBOX_STAGED_CREDENTIAL_TTL_MS + 1,
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
        )
        .expect("promoted handle survives TTL and remains rollbackable");

        assert_eq!(*active.borrow(), previous);
        assert!(!entries.contains_key("opaque-handle"));
    }

    #[test]
    fn first_connect_dropbox_rollback_restores_no_active_tokens() {
        use std::cell::RefCell;

        let mut entries = HashMap::new();
        let candidate = test_dropbox_tokens("candidate", 100_000);
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            candidate.clone(),
            100,
        )
        .expect("stage candidate");
        let active = RefCell::new(None::<DropboxTokenBundle>);

        promote_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
        )
        .expect("promote first connection");
        assert_eq!(*active.borrow(), Some(candidate));

        rollback_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            300,
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
        )
        .expect("clear first connection after failed activation");

        assert_eq!(*active.borrow(), None);
        assert!(!entries.contains_key("opaque-handle"));
    }

    #[test]
    fn dropbox_finalize_requires_promotion_and_discard_cannot_drop_rollback_state() {
        use std::cell::RefCell;

        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "opaque-handle".to_string(),
            test_dropbox_tokens("candidate", 100_000),
            100,
        )
        .expect("stage candidate");
        assert!(finalize_staged_dropbox_credentials_in_store(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
        )
        .is_err());

        let active = RefCell::new(None::<DropboxTokenBundle>);
        promote_staged_dropbox_credentials_with(
            &mut entries,
            "opaque-handle",
            "client-id",
            200,
            || Ok(active.borrow().clone()),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
        )
        .expect("promote candidate");
        assert!(discard_staged_dropbox_credentials_in_store(
            &mut entries,
            "opaque-handle",
            "client-id",
            300,
        )
        .is_err());
        assert!(entries.contains_key("opaque-handle"));

        finalize_staged_dropbox_credentials_in_store(
            &mut entries,
            "opaque-handle",
            "client-id",
            300,
        )
        .expect("finalize promoted candidate");
        assert!(!entries.contains_key("opaque-handle"));
    }

    #[test]
    fn unknown_rollback_after_committed_journal_clear_preserves_old_keyring() {
        use std::cell::{Cell, RefCell};

        let candidate = test_dropbox_tokens("candidate", 100_000);
        let previous = test_dropbox_tokens("previous", 90_000);
        let fallback = RefCell::new(Some(
            serde_json::to_string(&candidate).expect("serialize candidate fallback"),
        ));
        let keyring = RefCell::new(Some(
            serde_json::to_string(&previous).expect("serialize old keyring"),
        ));
        let keyring_writes = Cell::new(0usize);

        settle_unknown_dropbox_previous_after_recovery_with(
            &candidate,
            |journal| {
                resolve_unknown_dropbox_previous_credentials_with(journal, || {
                    Ok(keyring.borrow().clone())
                })
            },
            || {
                *fallback.borrow_mut() = None;
                Ok(())
            },
            || {
                let raw = fallback
                    .borrow()
                    .clone()
                    .or_else(|| keyring.borrow().clone());
                raw.map(|raw| parse_dropbox_token_bundle(&raw)).transpose()
            },
        )
        .expect("rollback reveals and verifies the untouched prior keyring bundle");

        assert!(fallback.borrow().is_none());
        assert_eq!(keyring_writes.get(), 0);
        assert_eq!(
            keyring
                .borrow()
                .as_deref()
                .map(parse_dropbox_token_bundle)
                .transpose()
                .expect("parse old keyring"),
            Some(previous)
        );

        let uncertain_fallback = RefCell::new(Some(
            serde_json::to_string(&candidate).expect("serialize retry candidate"),
        ));
        let clear_attempts = Cell::new(0usize);
        settle_unknown_dropbox_previous_after_recovery_with(
            &candidate,
            |journal| {
                resolve_unknown_dropbox_previous_credentials_with(journal, || {
                    Err("keyring unavailable".to_string())
                })
            },
            || {
                clear_attempts.set(clear_attempts.get() + 1);
                *uncertain_fallback.borrow_mut() = None;
                Ok(())
            },
            || Ok(None),
        )
        .expect_err("uncertain prior keyring state keeps fallback and handle retryable");
        assert_eq!(clear_attempts.get(), 0);
        assert!(uncertain_fallback.borrow().is_some());
    }

    #[test]
    fn resolved_handle_tombstones_make_finalize_retry_bound_and_bounded() {
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let mut handles = Vec::new();
        record_resolved_dropbox_credential_handle_with(
            &mut handles,
            "committed-handle",
            &candidate,
            1_000,
        )
        .expect("record resolved handle");

        assert!(resolved_dropbox_credential_handle_matches_with(
            &handles,
            "committed-handle",
            &candidate,
            1_001,
        )
        .expect("match committed retry"));
        assert!(!resolved_dropbox_credential_handle_matches_with(
            &handles,
            "different-handle",
            &candidate,
            1_001,
        )
        .expect("reject unrelated handle"));
        assert!(!resolved_dropbox_credential_handle_matches_with(
            &handles,
            "committed-handle",
            &candidate,
            1_000 + DROPBOX_RESOLVED_CREDENTIAL_HANDLE_TTL_MS + 1,
        )
        .expect("reject expired handle"));

        for index in 0..(DROPBOX_MAX_RESOLVED_CREDENTIAL_HANDLES + 4) {
            record_resolved_dropbox_credential_handle_with(
                &mut handles,
                &format!("handle-{index}"),
                &candidate,
                2_000 + index as i64,
            )
            .expect("record bounded handle");
        }
        assert_eq!(handles.len(), DROPBOX_MAX_RESOLVED_CREDENTIAL_HANDLES);
    }

    #[test]
    fn finalize_records_resolution_before_removal_and_journal_cleanup() {
        use std::cell::RefCell;

        let events = RefCell::new(Vec::new());
        let error = complete_committed_dropbox_finalize_with(
            || {
                events.borrow_mut().push("record-resolved");
                Ok(())
            },
            || {
                events.borrow_mut().push("remove-staged");
                Ok(())
            },
            || {
                events.borrow_mut().push("clear-journal");
                Err("injected journal clear failure".to_string())
            },
        )
        .expect_err("post-commit journal cleanup failure remains retryable");

        assert_eq!(
            *events.borrow(),
            vec!["record-resolved", "remove-staged", "clear-journal"]
        );
        assert!(error.contains("journal clear failure"));
    }

    #[test]
    fn non_staged_recovery_barrier_removes_promoted_entries_only_after_success() {
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "promoted".to_string(),
            test_dropbox_tokens("promoted", 100_000),
            100,
        )
        .expect("stage promoted entry");
        entries.get_mut("promoted").expect("promoted entry").phase =
            DropboxStagedCredentialPhase::Promoted {
                previous: DropboxPreviousCredentials::Empty,
            };
        insert_staged_dropbox_credentials(
            &mut entries,
            "candidate".to_string(),
            test_dropbox_tokens("candidate", 100_000),
            100,
        )
        .expect("stage candidate entry");

        recover_dropbox_before_sync_configuration_with(&mut entries, || {
            Err("recovery still pending".to_string())
        })
        .expect_err("failed recovery retains all handles");
        assert!(entries.contains_key("promoted"));

        recover_dropbox_before_sync_configuration_with(&mut entries, || Ok(()))
            .expect("settled recovery removes orphan promoted handles");
        assert!(!entries.contains_key("promoted"));
        assert!(entries.contains_key("candidate"));
    }

    #[test]
    fn committed_barrier_settles_before_off_and_disconnect_revokes_the_candidate() {
        use std::cell::{Cell, RefCell};

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let commit = RefCell::new(DropboxRecoveryCommitState {
            raw_backend: "cloud".to_string(),
            backend_marker: "cloud".to_string(),
            cloud_provider: "dropbox".to_string(),
            cloud_provider_authority: "native".to_string(),
        });
        let active = RefCell::new(Some(candidate.clone()));
        let journal = RefCell::new(Some(
            build_dropbox_promotion_journal(previous.clone(), &candidate)
                .expect("build committed journal"),
        ));
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "committed-handle".to_string(),
            candidate.clone(),
            100,
        )
        .expect("stage committed candidate");
        entries
            .get_mut("committed-handle")
            .expect("committed entry")
            .phase = DropboxStagedCredentialPhase::Promoted {
            previous: DropboxPreviousCredentials::from_tokens(previous),
        };

        recover_dropbox_before_sync_configuration_with(&mut entries, || {
            recover_dropbox_credentials_fail_closed_with_commit_state(
                || Ok(commit.borrow().clone()),
                |_backend| panic!("a committed cleanup barrier must not disable sync"),
                || Ok(active.borrow().clone()),
                |_pending| panic!("committed recovery never resolves prior credentials"),
                |_tokens| panic!("committed recovery never rewrites the candidate"),
                || Ok(journal.borrow().clone()),
                || {
                    *journal.borrow_mut() = None;
                    Ok(())
                },
            )
        })
        .expect("the pre-disable barrier settles the committed transaction");

        assert!(journal.borrow().is_none());
        assert_eq!(*active.borrow(), Some(candidate.clone()));
        assert!(!entries.contains_key("committed-handle"));

        commit.borrow_mut().raw_backend = "off".to_string();
        commit.borrow_mut().backend_marker = "off".to_string();
        let cleared_staged = Cell::new(false);
        let token_to_revoke = prepare_dropbox_disconnect_with(
            "client-id",
            || Ok(commit.borrow().clone()),
            || Ok(journal.borrow().clone()),
            || {
                recover_dropbox_credentials_fail_closed_with_commit_state(
                    || Ok(commit.borrow().clone()),
                    |_backend| panic!("settled recovery must not rewrite the backend"),
                    || panic!("an absent journal must not inspect active credentials"),
                    |_pending| panic!("an absent journal has no prior authority"),
                    |_tokens| panic!("an absent journal must not rewrite credentials"),
                    || Ok(journal.borrow().clone()),
                    || panic!("an absent journal must not be cleared"),
                )
            },
            || Ok(active.borrow().clone()),
            || {
                *active.borrow_mut() = None;
                Ok(())
            },
            || Ok(()),
            || cleared_staged.set(true),
        )
        .expect("disconnect after the barrier is safe");

        assert_eq!(token_to_revoke, Some(candidate));
        assert!(active.borrow().is_none());
        assert!(cleared_staged.get());
    }

    #[test]
    fn committed_barrier_failure_refuses_disable_without_post_commit_rollback() {
        use std::cell::{Cell, RefCell};

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let commit = DropboxRecoveryCommitState {
            raw_backend: "cloud".to_string(),
            backend_marker: "cloud".to_string(),
            cloud_provider: "dropbox".to_string(),
            cloud_provider_authority: "native".to_string(),
        };
        let active = RefCell::new(Some(candidate.clone()));
        let journal = RefCell::new(Some(
            build_dropbox_promotion_journal(previous, &candidate).expect("build committed journal"),
        ));
        let backend_writes = Cell::new(0usize);
        let credential_writes = Cell::new(0usize);
        let mut entries = HashMap::new();
        insert_staged_dropbox_credentials(
            &mut entries,
            "committed-handle".to_string(),
            candidate.clone(),
            100,
        )
        .expect("stage committed candidate");
        entries
            .get_mut("committed-handle")
            .expect("committed entry")
            .phase = DropboxStagedCredentialPhase::Promoted {
            previous: DropboxPreviousCredentials::Empty,
        };

        let error = recover_dropbox_before_sync_configuration_with(&mut entries, || {
            recover_dropbox_credentials_fail_closed_with_commit_state(
                || Ok(commit.clone()),
                |_backend| {
                    backend_writes.set(backend_writes.get() + 1);
                    Ok(())
                },
                || Ok(active.borrow().clone()),
                |_pending| panic!("committed recovery never resolves prior credentials"),
                |_tokens| {
                    credential_writes.set(credential_writes.get() + 1);
                    Ok(())
                },
                || Ok(journal.borrow().clone()),
                || Err("injected durable journal cleanup failure".to_string()),
            )
        })
        .expect_err("the caller must refuse its pending off write");

        assert!(error.contains("active Dropbox commit was left intact"));
        assert_eq!(backend_writes.get(), 0);
        assert_eq!(credential_writes.get(), 0);
        assert_eq!(*active.borrow(), Some(candidate));
        assert!(journal.borrow().is_some());
        assert!(entries.contains_key("committed-handle"));
    }

    #[test]
    fn uninitialized_provider_authority_never_commits_a_candidate() {
        use std::cell::RefCell;

        let previous = Some(test_dropbox_tokens("previous", 90_000));
        let candidate = test_dropbox_tokens("candidate", 100_000);
        let commit = RefCell::new(DropboxRecoveryCommitState {
            raw_backend: "cloud".to_string(),
            backend_marker: "cloud".to_string(),
            cloud_provider: "dropbox".to_string(),
            cloud_provider_authority: "uninitialized".to_string(),
        });
        let active = RefCell::new(Some(candidate.clone()));
        let journal = RefCell::new(Some(
            build_dropbox_promotion_journal(previous.clone(), &candidate)
                .expect("build uncommitted journal"),
        ));

        let error = recover_dropbox_credentials_fail_closed_with_commit_state(
            || Ok(commit.borrow().clone()),
            |backend| {
                commit.borrow_mut().raw_backend = backend.to_string();
                commit.borrow_mut().backend_marker = backend.to_string();
                Ok(())
            },
            || Ok(active.borrow().clone()),
            |_pending| panic!("the previous authority is already known"),
            |tokens| {
                *active.borrow_mut() = tokens.cloned();
                Ok(())
            },
            || Ok(journal.borrow().clone()),
            || {
                *journal.borrow_mut() = None;
                Ok(())
            },
        )
        .expect_err("uninitialized authority must fail closed as uncommitted");

        assert!(error.contains("sync was disabled and previous credentials were restored"));
        assert_eq!(commit.borrow().raw_backend, "off");
        assert_eq!(commit.borrow().backend_marker, "off");
        assert_eq!(*active.borrow(), previous);
        assert!(journal.borrow().is_none());
    }

    #[test]
    fn windows_root_authority_name_is_machine_wide_and_identity_bound() {
        let first = windows_sync_root_authority_name(&SyncLockIdentity {
            device_id: 0x12,
            file_id: 0x34,
        });
        let second = windows_sync_root_authority_name(&SyncLockIdentity {
            device_id: 0x12,
            file_id: 0x35,
        });

        assert_eq!(
            first,
            "Global\\Mindwtr.FileSync.0000000000000012.0000000000000034"
        );
        assert_ne!(first, second);
        assert!(!first.starts_with("Local\\"));
    }

    // T7: is_sync_lock_contention is defined far below this module (it's regular,
    // non-test code after mod tests closes elsewhere in this file) but is visible
    // here via `use super::*;` above — Rust module resolution isn't order-dependent.
    #[cfg(windows)]
    #[test]
    fn windows_lock_violation_error_is_sync_lock_contention() {
        let error = std::io::Error::from_raw_os_error(
            windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION as i32,
        );
        assert!(is_sync_lock_contention(&error));
    }

    #[cfg(windows)]
    #[test]
    fn windows_unrelated_os_error_is_not_sync_lock_contention() {
        let error = std::io::Error::from_raw_os_error(
            windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED as i32,
        );
        assert!(!is_sync_lock_contention(&error));
    }

    fn cheap_encrypted_artifact(passphrase: &str) -> Vec<u8> {
        let params = SyncCryptoKdfParams { m_kib: 64, t: 1, p: 1 };
        let material = derive_sync_key_material(passphrase, random_salt(), params)
            .expect("derive test key material");
        crate::sync_crypto::encrypt_sync_artifact(b"{\"tasks\":[]}", &material)
            .expect("encrypt test artifact")
    }

    #[test]
    fn passphrase_verify_accepts_correct_passphrase_on_stable_bytes() {
        let artifact = cheap_encrypted_artifact("correct horse");
        let outcome = verify_sync_passphrase_with_reread("correct horse", "test", || {
            Ok(artifact.clone())
        })
        .expect("verify should not error");
        assert!(outcome.is_some());
    }

    #[test]
    fn passphrase_verify_reports_wrong_passphrase_once_bytes_read_stable() {
        let artifact = cheap_encrypted_artifact("correct horse");
        let mut reads = 0;
        let outcome = verify_sync_passphrase_with_reread("battery staple", "test", || {
            reads += 1;
            Ok(artifact.clone())
        })
        .expect("verify should not error");
        assert!(outcome.is_none());
        // One initial read plus exactly one reread confirming the bytes settled.
        assert_eq!(reads, 2);
    }

    #[test]
    fn passphrase_verify_retries_a_torn_read_instead_of_reporting_wrong_passphrase() {
        let artifact = cheap_encrypted_artifact("correct horse");
        let mut torn = artifact.clone();
        let last = torn.len() - 1;
        torn[last] ^= 0x01;
        let mut reads = 0;
        let outcome = verify_sync_passphrase_with_reread("correct horse", "test", move || {
            reads += 1;
            Ok(if reads == 1 { torn.clone() } else { artifact.clone() })
        })
        .expect("verify should not error");
        assert!(outcome.is_some());
    }

    #[test]
    fn passphrase_provisioning_holds_the_sync_lock_through_key_persistence() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        enable_sync_encryption_in_dir(dir.path(), "correct horse")
            .expect("seed encrypted folder");

        let sync_dir = Arc::new(dir.path().to_path_buf());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let contender_dir = sync_dir.clone();
        let contender_barrier = barrier.clone();
        let contender = std::thread::spawn(move || {
            contender_barrier.wait();
            let attempt = acquire_sync_lock(&contender_dir);
            contender_barrier.wait();
            attempt
        });
        let persisted = Cell::new(false);

        let outcome = provide_sync_encryption_passphrase_in_dir_with(
            &sync_dir,
            "correct horse",
            || {
                barrier.wait();
                barrier.wait();
                Ok(())
            },
            |_, _| {
                persisted.set(true);
                Ok(())
            },
        )
        .expect("provision passphrase");

        let contender_result = contender.join().expect("contender completes");
        if let Ok(lock) = contender_result {
            release_sync_lock(&lock);
            panic!("a concurrent sync writer entered during passphrase provisioning");
        }
        assert_eq!(outcome, "ok");
        assert!(persisted.get());
    }

    #[test]
    fn passphrase_provisioning_rejects_a_generation_change_before_key_persistence() {
        let dir = tempfile::tempdir().expect("temp dir");
        seed_transition_folder(dir.path());
        let material = enable_sync_encryption_in_dir(dir.path(), "correct horse")
            .expect("seed encrypted folder");
        let changed_path = dir
            .path()
            .join(encrypted_artifact_name("data.json.bak"));
        let peer = encrypt_sync_artifact(
            br#"{"tasks":[{"id":"peer"}]}"#,
            &material,
        )
        .expect("peer generation");
        let persisted = Cell::new(false);

        let error = provide_sync_encryption_passphrase_in_dir_with(
            dir.path(),
            "correct horse",
            || fs::write(&changed_path, &peer).map_err(|error| error.to_string()),
            |_, _| {
                persisted.set(true);
                Ok(())
            },
        )
        .expect_err("a changed authenticated generation must abort provisioning");

        assert_eq!(error, SYNC_FILE_WRITE_CONFLICT);
        assert!(!persisted.get(), "stale key material must not be committed");
        assert_eq!(fs::read(&changed_path).expect("peer generation retained"), peer);
    }
}

#[tauri::command]
pub(crate) fn get_dropbox_redirect_uri() -> String {
    dropbox_redirect_uri()
}

// Already holds state.inner across its whole body, same convention every
// caller of recover_dropbox_credentials follows (B2).
#[tauri::command(async)]
pub(crate) fn is_dropbox_connected(
    app: tauri::AppHandle,
    state: tauri::State<'_, DropboxStagedCredentialState>,
    client_id: String,
) -> Result<bool, String> {
    let _entries = state.inner.lock().map_err(|error| error.to_string())?;
    let result = (|| {
        recover_dropbox_credentials(&app)?;
        let normalized_client_id = normalize_dropbox_client_id(&client_id)?;
        is_dropbox_connected_with(&normalized_client_id, || read_dropbox_tokens(&app))
    })();
    // An unreadable state file proves nothing either way; keep the error then.
    let has_evidence = read_dropbox_credential_state(&app)
        .map(|state| dropbox_state_has_credential_evidence(&state))
        .unwrap_or(true);
    dropbox_status_probe_outcome(result, has_evidence)
}

#[tauri::command]
pub(crate) async fn connect_dropbox(
    app: tauri::AppHandle,
    state: tauri::State<'_, DropboxStagedCredentialState>,
    client_id: String,
) -> Result<String, String> {
    let staged_entries = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let _entries = staged_entries.lock().map_err(|error| error.to_string())?;
            recover_dropbox_credentials(&app)?;
        }
        let tokens = run_dropbox_oauth(&app, &client_id)?;
        let mut entries = staged_entries.lock().map_err(|error| error.to_string())?;
        stage_dropbox_candidate_after_recovery_with(
            || recover_dropbox_credentials(&app),
            || stage_dropbox_credentials(&mut entries, tokens, now_unix_ms()),
        )
    })
    .await
    .map_err(|error| format!("Dropbox OAuth task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn get_dropbox_access_token(
    app: tauri::AppHandle,
    state: tauri::State<'_, DropboxStagedCredentialState>,
    client_id: String,
    credential_handle: Option<String>,
    force_refresh: Option<bool>,
) -> Result<String, String> {
    let should_force_refresh = force_refresh.unwrap_or(false);
    let staged_entries = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = staged_entries.lock().map_err(|error| error.to_string())?;
        recover_dropbox_credentials(&app)?;
        if let Some(credential_handle) = credential_handle {
            let credential_handle = credential_handle.trim();
            if credential_handle.is_empty() {
                return Err("Dropbox credential handle is empty".to_string());
            }
            return get_valid_staged_dropbox_access_token(
                &app,
                &mut entries,
                credential_handle,
                &client_id,
                should_force_refresh,
            );
        }
        get_valid_dropbox_access_token(&app, &client_id, should_force_refresh)
    })
    .await
    .map_err(|error| format!("Dropbox token task failed: {error}"))?
}

fn ensure_native_sync_backend_disabled(app: &tauri::AppHandle) -> Result<(), String> {
    let commit = read_native_dropbox_recovery_commit_state(app)?;
    if !dropbox_recovery_state_is_durably_off(&commit) {
        return Err("Dropbox credentials can only be changed while sync is disabled".to_string());
    }
    Ok(())
}

fn ensure_dropbox_disconnect_backend_safe(
    commit: &DropboxRecoveryCommitState,
) -> Result<(), String> {
    if commit.raw_backend.trim() != commit.backend_marker.trim() {
        return Err(
            "Dropbox disconnect was refused because native sync markers are inconsistent"
                .to_string(),
        );
    }
    match commit.raw_backend.trim() {
        "off" | "file" | "webdav" | "cloudkit" => Ok(()),
        "cloud" if commit.cloud_provider_authority.trim() != "native" => Err(
            "Dropbox disconnect was refused because cloud provider authority is uninitialized"
                .to_string(),
        ),
        "cloud" if commit.cloud_provider.trim() == "selfhosted" => Ok(()),
        "cloud" if commit.cloud_provider.trim() == "dropbox" => Err(
            "Dropbox cannot be disconnected while the Dropbox sync backend is active".to_string(),
        ),
        _ => Err(
            "Dropbox disconnect was refused because the native sync provider is unknown"
                .to_string(),
        ),
    }
}

fn prepare_dropbox_disconnect_with<
    ReadCommitState,
    ReadJournal,
    Recover,
    ReadTokens,
    ClearTokens,
    ClearJournal,
    ClearStaged,
>(
    client_id: &str,
    mut read_commit_state: ReadCommitState,
    mut read_journal: ReadJournal,
    mut recover: Recover,
    mut read_tokens: ReadTokens,
    mut clear_tokens: ClearTokens,
    mut clear_journal: ClearJournal,
    mut clear_staged: ClearStaged,
) -> Result<Option<DropboxTokenBundle>, String>
where
    ReadCommitState: FnMut() -> Result<DropboxRecoveryCommitState, String>,
    ReadJournal: FnMut() -> Result<Option<DropboxCredentialPromotionJournal>, String>,
    Recover: FnMut() -> Result<(), String>,
    ReadTokens: FnMut() -> Result<Option<DropboxTokenBundle>, String>,
    ClearTokens: FnMut() -> Result<(), String>,
    ClearJournal: FnMut() -> Result<(), String>,
    ClearStaged: FnMut(),
{
    let commit = read_commit_state()?;
    ensure_dropbox_disconnect_backend_safe(&commit)?;
    if read_journal()?.is_some() {
        return Err(
            "Dropbox disconnect was refused because credential recovery must settle before the sync backend changes"
                .to_string(),
        );
    }
    recover()?;
    let token_to_revoke = read_tokens()
        .ok()
        .flatten()
        .filter(|tokens| tokens.client_id == client_id && !tokens.access_token.trim().is_empty());
    clear_tokens()?;
    clear_journal()?;
    clear_staged();
    Ok(token_to_revoke)
}

fn stage_dropbox_candidate_after_recovery_with<T, Recover, Stage>(
    mut recover: Recover,
    stage: Stage,
) -> Result<T, String>
where
    Recover: FnMut() -> Result<(), String>,
    Stage: FnOnce() -> Result<T, String>,
{
    recover()?;
    stage()
}

fn recover_dropbox_before_sync_configuration_with<Recover>(
    entries: &mut HashMap<String, DropboxStagedCredential>,
    mut recover: Recover,
) -> Result<bool, String>
where
    Recover: FnMut() -> Result<(), String>,
{
    recover()?;
    entries
        .retain(|_, entry| !matches!(entry.phase, DropboxStagedCredentialPhase::Promoted { .. }));
    Ok(true)
}

// Already holds state.inner across its whole body (B2).
#[tauri::command(async)]
pub(crate) fn recover_dropbox_credentials_before_sync_configuration(
    app: tauri::AppHandle,
    state: tauri::State<'_, DropboxStagedCredentialState>,
) -> Result<bool, String> {
    let mut entries = state.inner.lock().map_err(|error| error.to_string())?;
    recover_dropbox_before_sync_configuration_with(&mut entries, || {
        recover_dropbox_credentials(&app)
    })
}

#[tauri::command]
pub(crate) async fn promote_staged_dropbox_credentials(
    app: tauri::AppHandle,
    state: tauri::State<'_, DropboxStagedCredentialState>,
    client_id: String,
    credential_handle: String,
) -> Result<bool, String> {
    let staged_entries = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let normalized_client_id = normalize_dropbox_client_id(&client_id)?;
        let mut entries = staged_entries.lock().map_err(|error| error.to_string())?;
        recover_dropbox_credentials(&app)?;
        promote_staged_dropbox_credentials_with_journal(
            &mut entries,
            credential_handle.trim(),
            &normalized_client_id,
            now_unix_ms(),
            || read_native_durably_disabled_sync_backend(&app),
            || read_dropbox_previous_credentials_for_promotion(&app),
            || read_dropbox_tokens_for_recovery(&app),
            |tokens| write_optional_dropbox_tokens(&app, tokens),
            |tokens| write_dropbox_tokens_fallback_only(&app, tokens),
            || read_dropbox_promotion_journal(&app),
            |journal| write_dropbox_promotion_journal(&app, journal),
        )?;
        Ok::<bool, String>(true)
    })
    .await
    .map_err(|error| format!("Dropbox credential promotion task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn rollback_staged_dropbox_credentials(
    app: tauri::AppHandle,
    state: tauri::State<'_, DropboxStagedCredentialState>,
    client_id: String,
    credential_handle: String,
) -> Result<bool, String> {
    let staged_entries = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let normalized_client_id = normalize_dropbox_client_id(&client_id)?;
        let mut entries = staged_entries.lock().map_err(|error| error.to_string())?;
        ensure_native_sync_backend_disabled(&app)?;
        let (unknown_previous, candidate) = {
            let entry = staged_dropbox_entry_mut(
                &mut entries,
                credential_handle.trim(),
                &normalized_client_id,
                now_unix_ms(),
            )?;
            (
                matches!(
                    entry.phase,
                    DropboxStagedCredentialPhase::Promoted {
                        previous: DropboxPreviousCredentials::UnknownKeyring
                    }
                ),
                entry.tokens.clone(),
            )
        };
        recover_dropbox_credentials(&app)?;
        if unknown_previous {
            settle_unknown_dropbox_previous_after_recovery_with(
                &candidate,
                |journal| resolve_unknown_dropbox_previous_credentials(&app, journal),
                || clear_dropbox_tokens_fallback_only(&app),
                || read_dropbox_tokens_for_recovery(&app),
            )?;
            entries.remove(credential_handle.trim());
            return Ok::<bool, String>(true);
        }
        rollback_staged_dropbox_credentials_with(
            &mut entries,
            credential_handle.trim(),
            &normalized_client_id,
            now_unix_ms(),
            || read_dropbox_tokens_for_recovery(&app),
            |tokens| write_optional_dropbox_tokens(&app, tokens),
        )?;
        Ok::<bool, String>(true)
    })
    .await
    .map_err(|error| format!("Dropbox credential rollback task failed: {error}"))?
}

// Already holds state.inner across its whole body (B2).
#[tauri::command(async)]
pub(crate) fn finalize_staged_dropbox_credentials(
    app: tauri::AppHandle,
    state: tauri::State<'_, DropboxStagedCredentialState>,
    client_id: String,
    credential_handle: String,
) -> Result<bool, String> {
    let normalized_client_id = normalize_dropbox_client_id(&client_id)?;
    let mut entries = state.inner.lock().map_err(|error| error.to_string())?;
    let credential_handle = credential_handle.trim();
    let commit = read_native_dropbox_recovery_commit_state(&app)?;
    if commit.raw_backend.trim() != "cloud"
        || commit.backend_marker.trim() != "cloud"
        || commit.cloud_provider.trim() != "dropbox"
        || commit.cloud_provider_authority.trim() != "native"
    {
        return Err(
            "Dropbox credentials cannot be finalized before the Dropbox backend is committed"
                .to_string(),
        );
    }
    if !entries.contains_key(credential_handle) {
        let active = read_dropbox_tokens_for_recovery(&app)?.ok_or_else(|| {
            "Resolved Dropbox credentials are missing during finalize retry".to_string()
        })?;
        let state = read_dropbox_credential_state(&app)?;
        if !resolved_dropbox_credential_handle_matches_with(
            &state.resolved_credential_handles,
            credential_handle,
            &active,
            now_unix_ms(),
        )? {
            return Err("Dropbox credential handle is invalid or expired".to_string());
        }
        if read_dropbox_promotion_journal(&app)?.is_some() {
            clear_dropbox_promotion_journal(&app)?;
            if read_dropbox_promotion_journal(&app)?.is_some() {
                return Err(
                    "Dropbox credential promotion journal remains pending after finalize retry"
                        .to_string(),
                );
            }
        }
        return Ok(true);
    }
    let entry = staged_dropbox_entry_mut(
        &mut entries,
        credential_handle,
        &normalized_client_id,
        now_unix_ms(),
    )?;
    if !matches!(entry.phase, DropboxStagedCredentialPhase::Promoted { .. }) {
        return Err("Dropbox credentials cannot be finalized before promotion".to_string());
    }
    let candidate = entry.tokens.clone();
    if let Some(journal) = read_dropbox_promotion_journal(&app)? {
        if !journal_matches_candidate(&journal, &candidate)? {
            return Err(
                "Final Dropbox credentials do not match their recovery journal".to_string(),
            );
        }
    }
    if read_dropbox_tokens_for_recovery(&app)?.as_ref() != Some(&candidate) {
        return Err("Final Dropbox credentials failed durable read-back verification".to_string());
    }
    complete_committed_dropbox_finalize_with(
        || record_resolved_dropbox_credential_handle(&app, credential_handle, &candidate),
        || {
            finalize_staged_dropbox_credentials_in_store(
                &mut entries,
                credential_handle,
                &normalized_client_id,
                now_unix_ms(),
            )
        },
        || clear_dropbox_promotion_journal(&app),
    )?;
    if read_dropbox_promotion_journal(&app)?.is_some() {
        return Err(
            "Dropbox credential promotion journal remains pending after finalize".to_string(),
        );
    }
    Ok(true)
}

#[tauri::command]
pub(crate) fn discard_staged_dropbox_credentials(
    state: tauri::State<'_, DropboxStagedCredentialState>,
    client_id: String,
    credential_handle: String,
) -> Result<bool, String> {
    let normalized_client_id = normalize_dropbox_client_id(&client_id)?;
    let mut entries = state.inner.lock().map_err(|error| error.to_string())?;
    discard_staged_dropbox_credentials_in_store(
        &mut entries,
        credential_handle.trim(),
        &normalized_client_id,
        now_unix_ms(),
    )?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn disconnect_dropbox(
    app: tauri::AppHandle,
    state: tauri::State<'_, DropboxStagedCredentialState>,
    client_id: String,
) -> Result<bool, String> {
    let staged_entries = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let normalized_client_id = normalize_dropbox_client_id(&client_id)?;
        let mut entries = staged_entries.lock().map_err(|error| error.to_string())?;
        let token_to_revoke = prepare_dropbox_disconnect_with(
            &normalized_client_id,
            || read_native_dropbox_recovery_commit_state(&app),
            || read_dropbox_promotion_journal(&app),
            || recover_dropbox_credentials(&app),
            || read_dropbox_tokens_for_recovery(&app),
            || clear_dropbox_credentials_for_disconnect(&app),
            || strictly_purge_dropbox_promotion_journal(&app),
            || entries.retain(|_, entry| entry.tokens.client_id != normalized_client_id),
        )?;
        drop(entries);

        if let Some(tokens) = token_to_revoke {
            if let Ok(client) = app_blocking_http_client(&app) {
                let _ = client
                    .post(DROPBOX_REVOKE_ENDPOINT)
                    .bearer_auth(tokens.access_token)
                    .send();
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("Dropbox disconnect task failed: {error}"))??;
    Ok(true)
}

pub(crate) fn is_icloud_evicted(path: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    if let Some(ext) = path.extension() {
        if ext == "icloud" {
            return true;
        }
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) {
        let placeholder_name = format!(".{}.icloud", name);
        let placeholder_path = parent.join(&placeholder_name);
        if placeholder_path.exists() && !path.exists() {
            return true;
        }
        if placeholder_path.exists() && path.exists() {
            if let Ok(meta) = fs::metadata(path) {
                if meta.len() < 50 {
                    return true;
                }
            }
        }
    }
    false
}

fn is_icloud_path(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    path_str.contains("Library/Mobile Documents/") || path_str.contains("iCloud")
}

const SYNC_FILE_WRITE_CONFLICT: &str = "SYNC_FILE_WRITE_CONFLICT";

#[derive(Clone, Debug, PartialEq, Eq)]
struct SyncLockIdentity {
    device_id: u64,
    file_id: u64,
}

#[derive(Debug)]
struct SyncFileLock {
    sync_root: File,
    sync_root_identity: SyncLockIdentity,
    file: File,
    file_identity: SyncLockIdentity,
    #[cfg(target_os = "windows")]
    _root_semaphore: WindowsSyncRootSemaphore,
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct WindowsSyncRootSemaphore {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
// The handle is an owned kernel object and is only released while the enclosing
// File Sync lease is exclusively borrowed or dropped.
unsafe impl Send for WindowsSyncRootSemaphore {}

#[cfg(target_os = "windows")]
impl Drop for WindowsSyncRootSemaphore {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseSemaphore;

        // A semaphore is deliberately used instead of a named mutex: Windows
        // mutexes are recursive and thread-affine, so two renderer commands on
        // one runtime thread could both enter and a different drop thread could
        // not release ownership. The count-one semaphore is process-crossing,
        // non-recursive, and may be released from the drop thread.
        if unsafe { ReleaseSemaphore(self.handle, 1, std::ptr::null_mut()) } == 0 {
            log::warn!(
                "Failed to release stable File Sync root authority: {}",
                std::io::Error::last_os_error()
            );
        }
        unsafe { CloseHandle(self.handle) };
    }
}

#[derive(Debug)]
struct HeldFileSyncLease {
    sync_dir: PathBuf,
    owner_window_label: String,
    _sync_lock: SyncFileLock,
    publication_root: file_sync_attachment_publication::PublicationRoot,
}

/// Opaque, process-bounded File Sync leases held for a complete renderer sync
/// cycle. The stable `.mindwtr.lock` inode is shared with native encryption
/// transitions; a renderer cannot forge a token for a different folder.
#[derive(Debug, Default)]
pub(crate) struct FileSyncLeaseState {
    leases: Mutex<HashMap<String, HeldFileSyncLease>>,
}

fn is_sync_lock_contention(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::WouldBlock {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        return error.raw_os_error()
            == Some(windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION as i32);
    }

    #[cfg(not(target_os = "windows"))]
    false
}

fn sync_lock_error_message(error: &std::io::Error) -> String {
    if is_sync_lock_contention(error) {
        "Sync lock held by another process".to_string()
    } else {
        format!(
            "Failed to acquire an exclusive sync lock; this filesystem may not support safe concurrent writes: {error}"
        )
    }
}

#[cfg(unix)]
fn sync_lock_identity(file: &File, require_directory: bool) -> Result<SyncLockIdentity, String> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to identify File Sync lease authority: {error}"))?;
    let kind_ok = if require_directory {
        metadata.file_type().is_dir()
    } else {
        metadata.file_type().is_file()
    };
    if !kind_ok || metadata.file_type().is_symlink() {
        return Err("File Sync lease authority is not an exact regular node".to_string());
    }
    Ok(SyncLockIdentity {
        device_id: metadata.dev(),
        file_id: metadata.ino(),
    })
}

#[cfg(target_os = "windows")]
fn sync_lock_identity(file: &File, require_directory: bool) -> Result<SyncLockIdentity, String> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a live handle and the output structure is writable.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(format!(
            "Failed to identify File Sync lease authority: {}",
            std::io::Error::last_os_error()
        ));
    }
    let is_directory = information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if is_directory != require_directory
        || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("File Sync lease authority is a reparse point or unexpected node".to_string());
    }
    Ok(SyncLockIdentity {
        device_id: u64::from(information.dwVolumeSerialNumber),
        file_id: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

#[cfg(not(any(unix, target_os = "windows")))]
fn sync_lock_identity(_file: &File, _require_directory: bool) -> Result<SyncLockIdentity, String> {
    Err("Stable File Sync lease authority is unavailable on this platform".to_string())
}

fn open_sync_root_authority(sync_dir: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options
            .access_mode(GENERIC_READ | GENERIC_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(sync_dir)
        .map_err(|error| format!("Failed to open stable File Sync root authority: {error}"))?;
    sync_lock_identity(&file, true)?;
    Ok(file)
}

#[cfg(unix)]
fn acquire_sync_root_authority(root: &File, _identity: &SyncLockIdentity) -> Result<(), String> {
    root.try_lock_exclusive().map_err(|error| sync_lock_error_message(&error))
}

#[cfg(any(test, target_os = "windows"))]
fn windows_sync_root_authority_name(identity: &SyncLockIdentity) -> String {
    format!(
        "Global\\Mindwtr.FileSync.{:016x}.{:016x}",
        identity.device_id, identity.file_id
    )
}

#[cfg(target_os = "windows")]
fn acquire_sync_root_authority(
    _root: &File,
    identity: &SyncLockIdentity,
) -> Result<WindowsSyncRootSemaphore, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{CreateSemaphoreW, WaitForSingleObject};

    let name = windows_sync_root_authority_name(identity);
    let wide = name.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    // `Global\\` is shared by every logon session. A null SECURITY_ATTRIBUTES
    // pointer deliberately applies the creator token's default DACL, so the
    // same account can reopen the authority across sessions without granting
    // other users access. Do not fall back to `Local\\` if creation is denied:
    // that would silently split the stable authority into concurrent owners.
    // SAFETY: the name is NUL-terminated and remains alive through the call.
    let handle = unsafe { CreateSemaphoreW(std::ptr::null(), 1, 1, wide.as_ptr()) };
    if handle.is_null() {
        return Err(format!(
            "Failed to create machine-wide stable File Sync root authority: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `handle` is a live semaphore handle owned by this function.
    match unsafe { WaitForSingleObject(handle, 0) } {
        WAIT_OBJECT_0 => Ok(WindowsSyncRootSemaphore { handle }),
        WAIT_TIMEOUT => {
            unsafe { CloseHandle(handle) };
            Err("Sync lock held by another process".to_string())
        }
        _ => {
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            Err(format!("Failed to acquire stable File Sync root authority: {error}"))
        }
    }
}

/// Taking the lock needs no write access — `flock` accepts a read-only
/// descriptor and `LockFileEx` accepts a `GENERIC_READ` handle — so ask for it
/// only when the file has to be created. Write-opening an *existing* file is
/// what a cache-off rclone VFS mount refuses: it hands back a write handle,
/// then refuses at close, logging an error on every sync (#1001). Creating a
/// missing file is the one write those mounts always allow.
fn open_sync_lock_file(lock_path: &Path, writable: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    if writable {
        options.write(true).create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(lock_path)
}

fn acquire_sync_lock(sync_dir: &Path) -> Result<SyncFileLock, String> {
    // Current versions use the retained root inode/kernel identity as the
    // unreplaceable authority. The named lock file remains locked second so an
    // older cooperating client still serializes with us. A malicious same-UID
    // process that can replace an already-open root is outside this boundary;
    // every pathname identity is nevertheless revalidated before finalization.
    let sync_root = open_sync_root_authority(sync_dir)?;
    let sync_root_identity = sync_lock_identity(&sync_root, true)?;
    #[cfg(unix)]
    acquire_sync_root_authority(&sync_root, &sync_root_identity)?;
    #[cfg(target_os = "windows")]
    let root_semaphore = acquire_sync_root_authority(&sync_root, &sync_root_identity)?;

    let lock_path = sync_dir.join(".mindwtr.lock");
    let file = open_sync_lock_file(&lock_path, false)
        // Any refusal of the read-only open — a lock file that does not exist
        // yet, a mount that answers oddly — falls back to the writable open used
        // before #1001, so the set of filesystems that can take the lock at all
        // only grows.
        .or_else(|_| open_sync_lock_file(&lock_path, true))
        .map_err(|error| format!("Failed to open sync lock: {error}"))?;
    let file_identity = sync_lock_identity(&file, false)?;
    let read_only_error = match file.try_lock_exclusive() {
        Ok(()) => {
            let lock = SyncFileLock {
                sync_root,
                sync_root_identity,
                file,
                file_identity,
                #[cfg(target_os = "windows")]
                _root_semaphore: root_semaphore,
            };
            revalidate_sync_lock(&lock, sync_dir)?;
            return Ok(lock);
        }
        Err(error) if is_sync_lock_contention(&error) => {
            return Err(sync_lock_error_message(&error))
        }
        Err(error) => error,
    };

    // No documented `flock`/`LockFileEx` implementation refuses a read-only
    // handle, but sync must not break outright on a filesystem that disagrees:
    // retry on the writable handle this used before #1001.
    log::warn!(
        "Sync lock rejected on a read-only handle ({read_only_error}); retrying with a writable handle"
    );
    let file = open_sync_lock_file(&lock_path, true)
        .map_err(|error| format!("Failed to open sync lock: {error}"))?;
    let file_identity = sync_lock_identity(&file, false)?;
    match file.try_lock_exclusive() {
        Ok(()) => {
            let lock = SyncFileLock {
                sync_root,
                sync_root_identity,
                file,
                file_identity,
                #[cfg(target_os = "windows")]
                _root_semaphore: root_semaphore,
            };
            revalidate_sync_lock(&lock, sync_dir)?;
            Ok(lock)
        }
        Err(error) => Err(sync_lock_error_message(&error)),
    }
}

fn revalidate_sync_lock(sync_lock: &SyncFileLock, sync_dir: &Path) -> Result<(), String> {
    let root = open_sync_root_authority(sync_dir)?;
    if sync_lock_identity(&root, true)? != sync_lock.sync_root_identity
        || sync_lock_identity(&sync_lock.sync_root, true)? != sync_lock.sync_root_identity
    {
        return Err("File Sync root authority changed while the lease was held".to_string());
    }
    let named = open_sync_lock_file(&sync_dir.join(".mindwtr.lock"), false)
        .map_err(|error| format!("Failed to revalidate sync lock: {error}"))?;
    if sync_lock_identity(&named, false)? != sync_lock.file_identity
        || sync_lock_identity(&sync_lock.file, false)? != sync_lock.file_identity
    {
        return Err("File Sync lock identity changed while the lease was held".to_string());
    }
    Ok(())
}

fn release_sync_lock(sync_lock: &SyncFileLock) {
    if let Err(error) = FileExt::unlock(&sync_lock.file) {
        log::warn!("Failed to release sync file lock: {error}");
    }
    #[cfg(unix)]
    if let Err(error) = FileExt::unlock(&sync_lock.sync_root) {
        log::warn!("Failed to release stable File Sync root authority: {error}");
    }
}

fn normalize_lease_sync_dir(sync_dir: &Path) -> PathBuf {
    fs::canonicalize(sync_dir).unwrap_or_else(|_| sync_dir.to_path_buf())
}

fn acquire_file_sync_lease_for_dir(
    state: &FileSyncLeaseState,
    sync_dir: &Path,
    owner_window_label: &str,
) -> Result<String, String> {
    let sync_dir = normalize_lease_sync_dir(sync_dir);
    let publication_root = file_sync_attachment_publication::PublicationRoot::bind(&sync_dir)?;
    let sync_lock = acquire_sync_lock(&sync_dir)?;
    if let Err(error) = publication_root.revalidate_root() {
        release_sync_lock(&sync_lock);
        return Err(error);
    }
    let mut leases = state
        .leases
        .lock()
        .map_err(|_| "File Sync lease state is unavailable".to_string())?;
    let token = loop {
        let candidate = format!(
            "{:016x}{:016x}",
            rand::thread_rng().next_u64(),
            rand::thread_rng().next_u64()
        );
        if !leases.contains_key(&candidate) {
            break candidate;
        }
    };
    leases.insert(
        token.clone(),
        HeldFileSyncLease {
            sync_dir,
            owner_window_label: owner_window_label.to_string(),
            _sync_lock: sync_lock,
            publication_root,
        },
    );
    Ok(token)
}

fn with_file_sync_lease<T, F>(
    state: &FileSyncLeaseState,
    token: &str,
    owner_window_label: &str,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce(&mut HeldFileSyncLease) -> Result<T, String>,
{
    // Keep the map guard for the whole operation so a concurrent release cannot
    // drop the OS lock between token validation and the final journal/file write.
    let mut leases = state
        .leases
        .lock()
        .map_err(|_| "File Sync lease state is unavailable".to_string())?;
    let lease = leases
        .get_mut(token)
        .ok_or_else(|| "Unknown or already released File Sync lease".to_string())?;
    if lease.owner_window_label != owner_window_label {
        return Err("File Sync lease belongs to a different renderer window".to_string());
    }
    revalidate_sync_lock(&lease._sync_lock, &lease.sync_dir)?;
    lease.publication_root.revalidate_root()?;
    let result = operation(lease);
    let final_lock_validation = revalidate_sync_lock(&lease._sync_lock, &lease.sync_dir);
    match (result, final_lock_validation) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

fn release_file_sync_lease_token(
    state: &FileSyncLeaseState,
    token: &str,
    owner_window_label: &str,
) -> Result<(), String> {
    let mut leases = state
        .leases
        .lock()
        .map_err(|_| "File Sync lease state is unavailable".to_string())?;
    let lease = leases
        .get(token)
        .ok_or_else(|| "Unknown or already released File Sync lease".to_string())?;
    if lease.owner_window_label != owner_window_label {
        return Err("File Sync lease belongs to a different renderer window".to_string());
    }
    let lease = leases
        .remove(token)
        .ok_or_else(|| "Unknown or already released File Sync lease".to_string())?;
    drop(leases);
    let validation = revalidate_sync_lock(&lease._sync_lock, &lease.sync_dir);
    release_sync_lock(&lease._sync_lock);
    validation
}

/// Release only leases whose renderer window has been destroyed. A live
/// renderer's lease is never reclaimed by age or by another window.
pub(crate) fn release_file_sync_leases_for_window(
    state: &FileSyncLeaseState,
    owner_window_label: &str,
) -> Result<usize, String> {
    let mut leases = state
        .leases
        .lock()
        .map_err(|_| "File Sync lease state is unavailable".to_string())?;
    let owned_tokens = leases
        .iter()
        .filter_map(|(token, lease)| {
            (lease.owner_window_label == owner_window_label).then(|| token.clone())
        })
        .collect::<Vec<_>>();
    let owned_leases = owned_tokens
        .iter()
        .filter_map(|token| leases.remove(token))
        .collect::<Vec<_>>();
    drop(leases);
    let released = owned_leases.len();
    let mut first_error = None;
    for lease in owned_leases {
        if let Err(error) = revalidate_sync_lock(&lease._sync_lock, &lease.sync_dir) {
            first_error.get_or_insert(error);
        }
        release_sync_lock(&lease._sync_lock);
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(released),
    }
}

#[tauri::command(async)]
pub(crate) fn acquire_file_sync_lease(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileSyncLeaseState>,
    path: Option<String>,
) -> Result<String, String> {
    let sync_dir = match path {
        Some(path) => resolve_sync_dir_granting_scope(&app, path)?,
        None => configured_sync_dir(&app)?
            .ok_or_else(|| "Sync path is not configured".to_string())?,
    };
    let token = acquire_file_sync_lease_for_dir(&state, &sync_dir, window.label())?;
    let recovery = with_file_sync_lease(&state, &token, window.label(), |lease| {
        file_sync_attachment_publication::recover(
            &crate::storage::get_data_dir(&app),
            &mut lease.publication_root,
        )
        .map(|_| ())
    });
    if let Err(error) = recovery {
        // Recovery failed closed before the token escaped to the renderer.
        let _ = release_file_sync_lease_token(&state, &token, window.label());
        return Err(error);
    }
    Ok(token)
}

#[tauri::command(async)]
pub(crate) fn release_file_sync_lease(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileSyncLeaseState>,
    token: String,
) -> Result<(), String> {
    release_file_sync_lease_token(&state, &token, window.label())
}

/// The "no remote yet" payload for a fresh sync folder. Must include every
/// array/object surface on core `AppData` (packages/core/src/types.ts) —
/// omitting one here hands the JS sync cycle a partial remote payload that
/// crashes downstream code assuming every array is present (#990).
fn empty_remote_app_data() -> serde_json::Value {
    serde_json::json!({
        "tasks": [],
        "projects": [],
        "sections": [],
        "areas": [],
        "people": [],
        "settings": {}
    })
}

fn sync_parent_directory_for_durability(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let parent = path.parent().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "sync path has no parent")
        })?;
        return match File::open(parent).and_then(|directory| directory.sync_all()) {
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::InvalidInput | std::io::ErrorKind::Unsupported
                ) =>
            {
                log::warn!("Sync filesystem does not support directory metadata flushes: {error}");
                Ok(())
            }
            result => result,
        };
    }

    #[cfg(not(unix))]
    {
        // Rust's portable File API cannot open a Windows directory for
        // FlushFileBuffers. The replacement file itself is still flushed;
        // Unix platforms additionally persist the rename metadata above.
        let _ = path;
        Ok(())
    }
}

/// Direct-child I/O rooted at the exact directory handle retained by the File
/// Sync lease. Absolute paths are accepted only to validate/derive a single
/// leaf name; every native operation below is issued relative to `directory`.
/// This closes crashes and races with cooperating clients/providers. A malicious
/// same-UID process that can mutate private process handles remains outside the
/// File Sync threat boundary.
struct RetainedSyncRoot<'a> {
    sync_dir: &'a Path,
    directory: &'a File,
}

impl<'a> RetainedSyncRoot<'a> {
    fn new(sync_dir: &'a Path, sync_lock: &'a SyncFileLock) -> Self {
        Self {
            sync_dir,
            directory: &sync_lock.sync_root,
        }
    }

    fn leaf<'b>(&self, path: &'b Path) -> std::io::Result<&'b OsStr> {
        if path.parent() != Some(self.sync_dir) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "File Sync operation escaped the retained root",
            ));
        }
        path.file_name().filter(|name| !name.is_empty()).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "File Sync operation has no direct-child leaf",
            )
        })
    }

    fn open_read(&self, path: &Path) -> std::io::Result<File> {
        retained_root_open(self.directory, self.leaf(path)?, false, false, false)
    }

    fn create_new(&self, path: &Path) -> std::io::Result<File> {
        retained_root_open(self.directory, self.leaf(path)?, true, true, false)
    }

    fn create_or_truncate(&self, path: &Path) -> std::io::Result<File> {
        retained_root_open(self.directory, self.leaf(path)?, true, false, true)
    }

    fn read(&self, path: &Path) -> std::io::Result<Vec<u8>> {
        let mut file = self.open_read(path)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    fn write_new(&self, path: &Path, bytes: &[u8]) -> std::io::Result<File> {
        let mut file = self.create_new(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(file)
    }

    fn write_replace(&self, path: &Path, bytes: &[u8]) -> std::io::Result<File> {
        let mut file = self.create_or_truncate(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(file)
    }

    fn exists(&self, path: &Path) -> std::io::Result<bool> {
        match self.open_read(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn identity(&self, path: &Path) -> std::io::Result<NativeFileIdentity> {
        native_file_identity(&self.open_read(path)?)
    }

    fn has_identity(&self, path: &Path, expected: NativeFileIdentity) -> bool {
        self.identity(path).is_ok_and(|actual| actual == expected)
    }

    fn rename(&self, source: &Path, destination: &Path, replace: bool) -> std::io::Result<()> {
        retained_root_rename(
            self.directory,
            self.leaf(source)?,
            self.leaf(destination)?,
            replace,
        )
    }

    fn remove(&self, path: &Path) -> std::io::Result<()> {
        retained_root_remove(self.directory, self.leaf(path)?)
    }

    fn sync_directory(&self) -> std::io::Result<()> {
        retained_root_sync_directory(self.directory)
    }

    fn try_clone_directory(&self) -> std::io::Result<File> {
        self.directory.try_clone()
    }

    fn list_direct_child_names(&self) -> std::io::Result<Vec<OsString>> {
        retained_root_list_names(self.directory)
    }
}

#[cfg(unix)]
fn retained_root_leaf_c_string(leaf: &OsStr) -> std::io::Result<CString> {
    use std::os::unix::ffi::OsStrExt as _;
    CString::new(leaf.as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "leaf contains NUL"))
}

#[cfg(unix)]
fn retained_root_open(
    directory: &File,
    leaf: &OsStr,
    writable: bool,
    create_new: bool,
    truncate: bool,
) -> std::io::Result<File> {
    use std::os::fd::{AsRawFd as _, FromRawFd as _};

    let leaf = retained_root_leaf_c_string(leaf)?;
    let mut flags = if writable { libc::O_RDWR } else { libc::O_RDONLY };
    flags |= libc::O_CLOEXEC | libc::O_NOFOLLOW;
    if create_new {
        flags |= libc::O_CREAT | libc::O_EXCL;
    } else if truncate {
        flags |= libc::O_CREAT | libc::O_TRUNC;
    }
    let descriptor = unsafe { libc::openat(directory.as_raw_fd(), leaf.as_ptr(), flags, 0o600) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "File Sync direct child is not a regular file",
        ));
    }
    Ok(file)
}

#[cfg(target_os = "windows")]
fn retained_root_open(
    directory: &File,
    leaf: &OsStr,
    writable: bool,
    create_new: bool,
    truncate: bool,
) -> std::io::Result<File> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _};
    use windows_sys::Wdk::Foundation::{RtlNtStatusToDosError, OBJECT_ATTRIBUTES};
    use windows_sys::Wdk::Storage::FileSystem::{
        NtCreateFile, FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
        FILE_OPEN_REPARSE_POINT, FILE_OVERWRITE_IF, FILE_SYNCHRONOUS_IO_NONALERT,
    };
    use windows_sys::Win32::Foundation::{
        GENERIC_READ, GENERIC_WRITE, OBJ_CASE_INSENSITIVE, UNICODE_STRING,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        SYNCHRONIZE,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    let mut name = leaf.encode_wide().collect::<Vec<_>>();
    let byte_len = name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "File Sync leaf is too long")
        })?;
    let unicode = UNICODE_STRING {
        Length: byte_len,
        MaximumLength: byte_len,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: directory.as_raw_handle(),
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut handle = std::ptr::null_mut();
    let mut status_block = IO_STATUS_BLOCK::default();
    let desired_access = GENERIC_READ
        | if writable { GENERIC_WRITE } else { 0 }
        | if writable { DELETE } else { 0 }
        | SYNCHRONIZE;
    let disposition = if create_new {
        FILE_CREATE
    } else if truncate {
        FILE_OVERWRITE_IF
    } else {
        FILE_OPEN
    };
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &attributes,
            &mut status_block,
            std::ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            disposition,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        return Err(std::io::Error::from_raw_os_error(unsafe {
            RtlNtStatusToDosError(status)
        } as i32));
    }
    let file = unsafe { File::from_raw_handle(handle) };
    if !file.metadata()?.is_file()
        || file.metadata()?.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "File Sync direct child is a reparse point or unexpected node",
        ));
    }
    Ok(file)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn retained_root_open(
    _directory: &File,
    _leaf: &OsStr,
    _writable: bool,
    _create_new: bool,
    _truncate: bool,
) -> std::io::Result<File> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "retained-root File Sync I/O is unsupported",
    ))
}

#[cfg(target_os = "linux")]
fn retained_root_rename(
    directory: &File,
    source: &OsStr,
    destination: &OsStr,
    replace: bool,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd as _;

    let source = retained_root_leaf_c_string(source)?;
    let destination = retained_root_leaf_c_string(destination)?;
    let result = if replace {
        unsafe {
            libc::renameat(
                directory.as_raw_fd(),
                source.as_ptr(),
                directory.as_raw_fd(),
                destination.as_ptr(),
            )
        }
    } else {
        unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                directory.as_raw_fd(),
                source.as_ptr(),
                directory.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            ) as i32
        }
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if !replace
        && matches!(
            error.raw_os_error(),
            Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::EOPNOTSUPP)
        )
    {
        return retained_root_link_then_unlink_no_replace(
            directory,
            source.as_c_str(),
            destination.as_c_str(),
        );
    }
    Err(error)
}

#[cfg(target_os = "macos")]
fn retained_root_rename(
    directory: &File,
    source: &OsStr,
    destination: &OsStr,
    replace: bool,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd as _;

    let source = retained_root_leaf_c_string(source)?;
    let destination = retained_root_leaf_c_string(destination)?;
    let result = if replace {
        unsafe {
            libc::renameat(
                directory.as_raw_fd(),
                source.as_ptr(),
                directory.as_raw_fd(),
                destination.as_ptr(),
            )
        }
    } else {
        unsafe {
            libc::renameatx_np(
                directory.as_raw_fd(),
                source.as_ptr(),
                directory.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_EXCL,
            )
        }
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if !replace
        && matches!(
            error.raw_os_error(),
            Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::ENOTSUP)
        )
    {
        return retained_root_link_then_unlink_no_replace(
            directory,
            source.as_c_str(),
            destination.as_c_str(),
        );
    }
    Err(error)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn retained_root_rename(
    directory: &File,
    source: &OsStr,
    destination: &OsStr,
    replace: bool,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd as _;

    let source = retained_root_leaf_c_string(source)?;
    let destination = retained_root_leaf_c_string(destination)?;
    if replace {
        if unsafe {
            libc::renameat(
                directory.as_raw_fd(),
                source.as_ptr(),
                directory.as_raw_fd(),
                destination.as_ptr(),
            )
        } == 0
        {
            return Ok(());
        }
        return Err(std::io::Error::last_os_error());
    }
    retained_root_link_then_unlink_no_replace(
        directory,
        source.as_c_str(),
        destination.as_c_str(),
    )
}

#[cfg(unix)]
fn retained_root_link_then_unlink_no_replace(
    directory: &File,
    source: &CStr,
    destination: &CStr,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd as _;

    retained_root_link_then_unlink_no_replace_with(
        || {
            if unsafe {
                libc::linkat(
                    directory.as_raw_fd(),
                    source.as_ptr(),
                    directory.as_raw_fd(),
                    destination.as_ptr(),
                    0,
                )
            } == 0
            {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        },
        || {
            if unsafe { libc::unlinkat(directory.as_raw_fd(), source.as_ptr(), 0) } == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        },
    )
}

#[cfg(unix)]
fn retained_root_link_then_unlink_no_replace_with<Link, UnlinkSource>(
    mut link: Link,
    mut unlink_source: UnlinkSource,
) -> std::io::Result<()>
where
    Link: FnMut() -> std::io::Result<()>,
    UnlinkSource: FnMut() -> std::io::Result<()>,
{
    link()?;
    let Err(unlink_error) = unlink_source() else {
        return Ok(());
    };
    // Do not try to roll the destination back by pathname. A peer can replace
    // that name after `linkat` and before a compensating `unlinkat`, which
    // would delete the peer generation. Retaining the exact hard-linked
    // generation is the fail-safe outcome; callers report the failed source
    // retirement and preserve/recover the duplicate on a later pass.
    Err(std::io::Error::other(format!(
        "no-replace publication linked the exact source generation but could not retire the source; both names were preserved: {unlink_error}"
    )))
}

#[cfg(target_os = "windows")]
fn retained_root_rename(
    directory: &File,
    source: &OsStr,
    destination: &OsStr,
    replace: bool,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO,
    };

    let source = retained_root_open(directory, source, true, false, false)?;
    let target = destination.encode_wide().collect::<Vec<_>>();
    let fixed = std::mem::size_of::<FILE_RENAME_INFO>() - std::mem::size_of::<u16>();
    let buffer_bytes = fixed + target.len() * std::mem::size_of::<u16>();
    let words = buffer_bytes.div_ceil(std::mem::size_of::<usize>());
    // `FILE_RENAME_INFO` has pointer alignment; a byte vector does not promise
    // enough alignment for the typed header even though system allocators often
    // happen to provide it.
    let mut buffer = vec![0_usize; words];
    let information = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*information).Anonymous.ReplaceIfExists = replace;
        (*information).RootDirectory = directory.as_raw_handle();
        (*information).FileNameLength = (target.len() * std::mem::size_of::<u16>()) as u32;
        std::ptr::copy_nonoverlapping(
            target.as_ptr(),
            (*information).FileName.as_mut_ptr(),
            target.len(),
        );
        if SetFileInformationByHandle(
            source.as_raw_handle(),
            FileRenameInfo,
            information.cast(),
            buffer_bytes as u32,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn retained_root_rename(
    _directory: &File,
    _source: &OsStr,
    _destination: &OsStr,
    _replace: bool,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "retained-root File Sync rename is unsupported",
    ))
}

#[cfg(unix)]
fn retained_root_remove(directory: &File, leaf: &OsStr) -> std::io::Result<()> {
    use std::os::fd::AsRawFd as _;

    let leaf = retained_root_leaf_c_string(leaf)?;
    if unsafe { libc::unlinkat(directory.as_raw_fd(), leaf.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(error)
        }
    }
}

#[cfg(target_os = "windows")]
fn retained_root_remove(directory: &File, leaf: &OsStr) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };

    let file = match retained_root_open(directory, leaf, true, false, false) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let information = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&information as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn retained_root_remove(_directory: &File, _leaf: &OsStr) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "retained-root File Sync cleanup is unsupported",
    ))
}

#[cfg(unix)]
fn retained_root_sync_directory(directory: &File) -> std::io::Result<()> {
    directory.sync_all()
}

#[cfg(target_os = "windows")]
fn retained_root_sync_directory(directory: &File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::FlushFileBuffers;

    if unsafe { FlushFileBuffers(directory.as_raw_handle()) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn retained_root_sync_directory(_directory: &File) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "retained-root File Sync directory flush is unsupported",
    ))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn retained_root_list_names(directory: &File) -> std::io::Result<Vec<OsString>> {
    use std::os::fd::AsRawFd as _;
    use std::os::unix::ffi::OsStringExt as _;

    struct DirectoryStream(*mut libc::DIR);
    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            unsafe { libc::closedir(self.0) };
        }
    }

    let descriptor = unsafe { libc::dup(directory.as_raw_fd()) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let stream = unsafe { libc::fdopendir(descriptor) };
    if stream.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe { libc::close(descriptor) };
        return Err(error);
    }
    let stream = DirectoryStream(stream);
    unsafe { libc::rewinddir(stream.0) };
    let mut names = Vec::new();
    loop {
        #[cfg(target_os = "linux")]
        unsafe {
            *libc::__errno_location() = 0;
        }
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error().unwrap_or(0) == 0 {
                break;
            }
            return Err(error);
        }
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        names.push(OsString::from_vec(bytes.to_vec()));
    }
    Ok(names)
}

#[cfg(target_os = "windows")]
fn retained_root_list_names(directory: &File) -> std::io::Result<Vec<OsString>> {
    use std::os::windows::ffi::OsStringExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::ERROR_NO_MORE_FILES;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo,
        GetFileInformationByHandleEx, FILE_ID_BOTH_DIR_INFO,
    };

    let buffer_bytes = 64 * 1024;
    let words = buffer_bytes / std::mem::size_of::<usize>();
    let mut buffer = vec![0_usize; words];
    let mut restart = true;
    let mut names = Vec::new();
    loop {
        let class = if restart {
            FileIdBothDirectoryRestartInfo
        } else {
            FileIdBothDirectoryInfo
        };
        restart = false;
        if unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle(),
                class,
                buffer.as_mut_ptr().cast(),
                buffer_bytes as u32,
            )
        } == 0
        {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(error);
        }

        let mut offset = 0_usize;
        loop {
            if offset + std::mem::size_of::<FILE_ID_BOTH_DIR_INFO>() > buffer_bytes {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "File Sync directory enumeration returned a truncated entry",
                ));
            }
            let entry = unsafe {
                &*buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<FILE_ID_BOTH_DIR_INFO>()
            };
            let name_units = usize::try_from(entry.FileNameLength)
                .ok()
                .filter(|length| length % std::mem::size_of::<u16>() == 0)
                .map(|length| length / std::mem::size_of::<u16>())
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "File Sync directory enumeration returned an invalid name length",
                    )
                })?;
            let fixed = std::mem::size_of::<FILE_ID_BOTH_DIR_INFO>()
                - std::mem::size_of::<u16>();
            if offset + fixed + name_units * std::mem::size_of::<u16>() > buffer_bytes {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "File Sync directory enumeration returned a truncated name",
                ));
            }
            let name = unsafe { std::slice::from_raw_parts(entry.FileName.as_ptr(), name_units) };
            if name != ['.' as u16] && name != ['.' as u16, '.' as u16] {
                names.push(OsString::from_wide(name));
            }
            if entry.NextEntryOffset == 0 {
                break;
            }
            let next = usize::try_from(entry.NextEntryOffset).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "File Sync directory enumeration returned an invalid offset",
                )
            })?;
            if next == 0 || offset + next >= buffer_bytes {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "File Sync directory enumeration returned an out-of-range offset",
                ));
            }
            offset += next;
        }
    }
    Ok(names)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn retained_root_list_names(_directory: &File) -> std::io::Result<Vec<OsString>> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "retained-root File Sync enumeration is unsupported",
    ))
}

#[cfg(not(any(unix, target_os = "windows")))]
fn retained_root_list_names(_directory: &File) -> std::io::Result<Vec<OsString>> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "retained-root File Sync enumeration is unsupported",
    ))
}

/// `fs::copy` presizes the destination before writing it — `CopyFileExW` on
/// Windows, an explicit size change elsewhere — and a cache-off rclone VFS
/// refuses any size change ("WriteFileHandle: Truncate: Can't change size",
/// #1001), logging an error per sync even though the bytes still land. Writing
/// the destination sequentially through one freshly created handle is the write
/// shape those mounts always allow, and flushing that same handle avoids
/// reopening the file for write afterwards, which they also refuse.
#[cfg(test)]
fn copy_file_sequentially(source: &Path, destination: &Path) -> std::io::Result<()> {
    let contents = fs::read(source)?;
    write_bytes_sequentially(&contents, destination)
}

#[cfg(test)]
fn write_bytes_sequentially(contents: &[u8], destination: &Path) -> std::io::Result<()> {
    let mut file = File::create(destination)?;
    file.write_all(contents)?;
    file.sync_all()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AtomicWriteStage {
    Create,
    WriteAndSync,
    Rename,
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
struct AtomicWriteError {
    stage: AtomicWriteStage,
    detail: String,
    owned_temp: Option<OwnedAtomicPublication>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NativeFileIdentity {
    volume: u64,
    file: u128,
}

#[cfg(unix)]
fn native_file_identity(file: &File) -> std::io::Result<NativeFileIdentity> {
    let metadata = file.metadata()?;
    Ok(NativeFileIdentity {
        volume: metadata.dev(),
        file: u128::from(metadata.ino()),
    })
}

#[cfg(target_os = "windows")]
fn native_file_identity(file: &File) -> std::io::Result<NativeFileIdentity> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded = unsafe {
        GetFileInformationByHandle(file.as_raw_handle() as _, &mut information)
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(NativeFileIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: (u128::from(information.nFileIndexHigh) << 32)
            | u128::from(information.nFileIndexLow),
    })
}

#[cfg(test)]
fn open_file_leaf_no_follow(path: &Path) -> std::io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        return OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        };

        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "file leaf is a reparse point",
            ));
        }
        return Ok(file);
    }
}

#[cfg(test)]
fn path_has_identity(path: &Path, expected: NativeFileIdentity) -> bool {
    open_file_leaf_no_follow(path)
        .and_then(|file| native_file_identity(&file))
        .is_ok_and(|actual| actual == expected)
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
struct OwnedAtomicPublication {
    identity: NativeFileIdentity,
    path: PathBuf,
    cleanup_on_drop: bool,
}

#[cfg(test)]
impl OwnedAtomicPublication {
    fn verify_at(&self, path: &Path) -> Result<(), String> {
        if path_has_identity(path, self.identity) {
            Ok(())
        } else {
            Err("atomic write leaf was replaced before the operation completed".to_string())
        }
    }

    fn remove_with<BeforeRemove>(
        &self,
        path: &Path,
        before_remove: &mut BeforeRemove,
    ) -> Result<(), String>
    where
        BeforeRemove: FnMut(&Path) -> Result<(), String>,
    {
        if fs::symlink_metadata(path).is_err_and(|error| {
            error.kind() == std::io::ErrorKind::NotFound
        }) {
            return Ok(());
        }
        self.verify_at(path)?;
        let first_result = before_remove(path);
        if first_result.is_err() && self.verify_at(path).is_ok() {
            // Keep the stage-specific first error, but make the same one-time
            // best-effort retry the probe historically promised.
            if before_remove(path).is_ok() && self.verify_at(path).is_ok() {
                let _ = fs::remove_file(path);
            }
            return first_result;
        }
        self.verify_at(path)?;
        fs::remove_file(path).map_err(|error| error.to_string())
    }

}

#[cfg(test)]
impl Drop for OwnedAtomicPublication {
    fn drop(&mut self) {
        if self.cleanup_on_drop {
            remove_if_owned(&self.path, self.identity);
        }
    }
}

#[cfg(test)]
fn remove_if_owned(path: &Path, identity: NativeFileIdentity) {
    if path_has_identity(path, identity) {
        let _ = fs::remove_file(path);
    }
}

/// The one atomic write shape shared by real file sync and folder probing.
/// Keep the newly-created handle open through `write_all` and `sync_all`, then
/// release it before renaming. Virtual filesystems can refuse the flush lazily,
/// so the checked `sync_all` is part of the contract; the optional override only
/// preserves the existing Windows replacement behavior.
#[cfg(test)]
fn atomic_tmp_write_then_rename_with<BeforeStage>(
    tmp_file: &Path,
    destination: &Path,
    content: &[u8],
    before_stage: &mut BeforeStage,
    rename_override: Option<&mut dyn FnMut(&Path, &Path) -> Result<(), String>>,
    destination_may_exist: bool,
) -> Result<OwnedAtomicPublication, AtomicWriteError>
where
    BeforeStage: FnMut(AtomicWriteStage) -> Result<(), String>,
{
    before_stage(AtomicWriteStage::Create).map_err(|detail| AtomicWriteError {
        stage: AtomicWriteStage::Create,
        detail,
        owned_temp: None,
    })?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(tmp_file)
        .map_err(|error| AtomicWriteError {
            stage: AtomicWriteStage::Create,
            detail: error.to_string(),
            owned_temp: None,
        })?;
    let identity = match native_file_identity(&file) {
        Ok(identity) => identity,
        Err(error) => {
            return Err(AtomicWriteError {
                stage: AtomicWriteStage::Create,
                detail: format!("Could not identify newly-created temp file: {error}"),
                owned_temp: None,
            });
        }
    };

    let write_result = (|| {
        before_stage(AtomicWriteStage::WriteAndSync)?;
        file.write_all(content).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())
    })();
    drop(file);
    if let Err(detail) = write_result {
        remove_if_owned(tmp_file, identity);
        return Err(AtomicWriteError {
            stage: AtomicWriteStage::WriteAndSync,
            detail,
            owned_temp: None,
        });
    }

    if let Err(detail) = before_stage(AtomicWriteStage::Rename) {
        remove_if_owned(tmp_file, identity);
        return Err(AtomicWriteError {
            stage: AtomicWriteStage::Rename,
            detail,
            owned_temp: None,
        });
    }
    if !path_has_identity(tmp_file, identity) {
        return Err(AtomicWriteError {
            stage: AtomicWriteStage::Rename,
            detail: "Atomic write temp file was replaced before publication".to_string(),
            owned_temp: None,
        });
    }
    if !destination_may_exist && fs::symlink_metadata(destination).is_ok() {
        remove_if_owned(tmp_file, identity);
        return Err(AtomicWriteError {
            stage: AtomicWriteStage::Rename,
            detail: "Atomic write destination already exists".to_string(),
            owned_temp: None,
        });
    }
    let rename_result = match rename_override {
        Some(rename_file) => rename_file(tmp_file, destination),
        None => fs::rename(tmp_file, destination).map_err(|error| error.to_string()),
    };
    if let Err(detail) = rename_result {
        let owned_temp = path_has_identity(tmp_file, identity).then(|| OwnedAtomicPublication {
            identity,
            path: tmp_file.to_path_buf(),
            cleanup_on_drop: true,
        });
        return Err(AtomicWriteError {
            stage: AtomicWriteStage::Rename,
            detail,
            owned_temp,
        });
    }
    let publication = OwnedAtomicPublication {
        identity,
        path: destination.to_path_buf(),
        cleanup_on_drop: true,
    };
    publication.verify_at(destination).map_err(|detail| AtomicWriteError {
        stage: AtomicWriteStage::Rename,
        detail,
        owned_temp: None,
    })?;
    Ok(publication)
}

#[derive(Debug)]
struct RetainedAtomicWriteError {
    stage: AtomicWriteStage,
    detail: String,
    owned_temp: Option<OwnedRetainedRootPublication>,
}

#[derive(Debug)]
struct OwnedRetainedRootPublication {
    directory: File,
    sync_dir: PathBuf,
    leaf: OsString,
    identity: NativeFileIdentity,
    cleanup_on_drop: bool,
}

static RETAINED_CLEANUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn quarantine_and_remove_retained_identity_with<BeforeQuarantine>(
    root: &RetainedSyncRoot<'_>,
    path: &Path,
    identity: NativeFileIdentity,
    before_quarantine: &mut BeforeQuarantine,
) -> Result<(), String>
where
    BeforeQuarantine: FnMut(&Path) -> Result<(), String>,
{
    before_quarantine(path)?;
    for _ in 0..16 {
        let sequence = RETAINED_CLEANUP_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let quarantine = root.sync_dir.join(format!(
            ".mindwtr-probe-cleanup-{}-{sequence:016x}",
            std::process::id()
        ));
        match root.rename(path, &quarantine, false) {
            Ok(()) => {
                if !root.has_identity(&quarantine, identity) {
                    let restore = root.rename(&quarantine, path, false);
                    let preservation = match restore {
                        Ok(()) => {
                            "probe cleanup captured a replacement leaf; restored it without deleting it"
                                .to_string()
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            "probe cleanup captured a replacement leaf; preserved it in quarantine because the canonical name was occupied"
                                .to_string()
                        }
                        Err(error) => format!(
                            "probe cleanup captured a replacement leaf; preserved it in quarantine because restoration failed: {error}"
                        ),
                    };
                    root.sync_directory().map_err(|error| {
                        format!(
                            "{preservation}; failed to flush the preserved directory state: {error}"
                        )
                    })?;
                    return Err(preservation);
                }
                // The quarantine name is invocation-private and allocated with
                // a no-replace move. Cooperative peers never target it, so the
                // unlink cannot remove a shared canonical generation.
                root.remove(&quarantine)
                    .map_err(|error| format!("Failed to remove quarantined probe file: {error}"))?;
                root.sync_directory().map_err(|error| {
                    format!("Failed to flush probe cleanup directory metadata: {error}")
                })?;
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to quarantine probe file before cleanup: {error}"
                ))
            }
        }
    }
    Err("Could not allocate a unique probe cleanup quarantine".to_string())
}

fn quarantine_and_remove_retained_identity(
    root: &RetainedSyncRoot<'_>,
    path: &Path,
    identity: NativeFileIdentity,
) -> Result<(), String> {
    quarantine_and_remove_retained_identity_with(root, path, identity, &mut |_| Ok(()))
}

impl OwnedRetainedRootPublication {
    fn path(&self) -> PathBuf {
        self.sync_dir.join(&self.leaf)
    }

    fn root(&self) -> RetainedSyncRoot<'_> {
        RetainedSyncRoot {
            sync_dir: &self.sync_dir,
            directory: &self.directory,
        }
    }

    fn verify_at(&self, path: &Path) -> Result<(), String> {
        if path == self.path() && self.root().has_identity(path, self.identity) {
            Ok(())
        } else {
            Err("atomic write leaf was replaced before the operation completed".to_string())
        }
    }

    fn read_back(&self, path: &Path) -> Result<Vec<u8>, String> {
        self.verify_at(path)?;
        let bytes = self.root().read(path).map_err(|error| error.to_string())?;
        self.verify_at(path)?;
        Ok(bytes)
    }

    fn quarantine_and_remove(&self, path: &Path) -> Result<(), String> {
        let root = self.root();
        quarantine_and_remove_retained_identity(&root, path, self.identity)
    }

    fn remove_with<BeforeRemove>(
        &self,
        path: &Path,
        before_remove: &mut BeforeRemove,
    ) -> Result<(), String>
    where
        BeforeRemove: FnMut(&Path) -> Result<(), String>,
    {
        if !self.root().exists(path).map_err(|error| error.to_string())? {
            return Ok(());
        }
        self.verify_at(path)?;
        if let Err(first_error) = before_remove(path) {
            if before_remove(path).is_err() {
                return Err(first_error);
            }
            if let Err(cleanup_error) = self.quarantine_and_remove(path) {
                return Err(format!("{first_error}; cleanup retry failed safely: {cleanup_error}"));
            }
            return Err(first_error);
        }
        self.quarantine_and_remove(path)
    }

    fn keep(&mut self) {
        self.cleanup_on_drop = false;
    }
}

impl Drop for OwnedRetainedRootPublication {
    fn drop(&mut self) {
        if self.cleanup_on_drop {
            let path = self.path();
            let _ = self.quarantine_and_remove(&path);
        }
    }
}

fn atomic_retained_tmp_write_then_rename_with<BeforeStage>(
    root: &RetainedSyncRoot<'_>,
    tmp_file: &Path,
    destination: &Path,
    content: &[u8],
    before_stage: &mut BeforeStage,
    rename_override: Option<
        &mut dyn FnMut(
            &RetainedSyncRoot<'_>,
            &Path,
            &Path,
            &mut dyn FnMut() -> Result<(), String>,
        ) -> Result<(), String>,
    >,
    destination_may_exist: bool,
) -> Result<OwnedRetainedRootPublication, RetainedAtomicWriteError>
where
    BeforeStage: FnMut(AtomicWriteStage) -> Result<(), String>,
{
    before_stage(AtomicWriteStage::Create).map_err(|detail| RetainedAtomicWriteError {
        stage: AtomicWriteStage::Create,
        detail,
        owned_temp: None,
    })?;
    let mut file = root.create_new(tmp_file).map_err(|error| RetainedAtomicWriteError {
        stage: AtomicWriteStage::Create,
        detail: error.to_string(),
        owned_temp: None,
    })?;
    let identity = native_file_identity(&file).map_err(|error| RetainedAtomicWriteError {
        stage: AtomicWriteStage::Create,
        detail: format!("Could not identify newly-created temp file: {error}"),
        owned_temp: None,
    })?;

    let write_result = (|| {
        before_stage(AtomicWriteStage::WriteAndSync)?;
        file.write_all(content).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())
    })();
    drop(file);
    if let Err(detail) = write_result {
        let _ = quarantine_and_remove_retained_identity(root, tmp_file, identity);
        return Err(RetainedAtomicWriteError {
            stage: AtomicWriteStage::WriteAndSync,
            detail,
            owned_temp: None,
        });
    }

    if let Err(detail) = before_stage(AtomicWriteStage::Rename) {
        let _ = quarantine_and_remove_retained_identity(root, tmp_file, identity);
        return Err(RetainedAtomicWriteError {
            stage: AtomicWriteStage::Rename,
            detail,
            owned_temp: None,
        });
    }
    if !root.has_identity(tmp_file, identity) {
        return Err(RetainedAtomicWriteError {
            stage: AtomicWriteStage::Rename,
            detail: "Atomic write temp file was replaced before publication".to_string(),
            owned_temp: None,
        });
    }
    let retained_directory = match root.try_clone_directory() {
        Ok(directory) => directory,
        Err(error) => {
            let _ = quarantine_and_remove_retained_identity(root, tmp_file, identity);
            return Err(RetainedAtomicWriteError {
                stage: AtomicWriteStage::Rename,
                detail: format!("Failed to retain sync root before publication: {error}"),
                owned_temp: None,
            });
        }
    };
    let rename_result = match rename_override {
        Some(rename) => rename(root, tmp_file, destination, &mut || {
            before_stage(AtomicWriteStage::Rename)
        }),
        None => root
            .rename(tmp_file, destination, destination_may_exist)
            .map_err(|error| error.to_string()),
    };
    if let Err(detail) = rename_result {
        let owned_temp = Some(OwnedRetainedRootPublication {
            directory: retained_directory,
            sync_dir: root.sync_dir.to_path_buf(),
            leaf: tmp_file
                .file_name()
                .expect("validated direct-child temp has a leaf")
                .to_os_string(),
            identity,
            cleanup_on_drop: true,
        });
        return Err(RetainedAtomicWriteError {
            stage: AtomicWriteStage::Rename,
            detail,
            owned_temp,
        });
    }
    let publication = OwnedRetainedRootPublication {
        directory: retained_directory,
        sync_dir: root.sync_dir.to_path_buf(),
        leaf: destination
            .file_name()
            .expect("validated direct-child destination has a leaf")
            .to_os_string(),
        identity,
        cleanup_on_drop: true,
    };
    publication.verify_at(destination).map_err(|detail| RetainedAtomicWriteError {
        stage: AtomicWriteStage::Rename,
        detail,
        owned_temp: None,
    })?;
    Ok(publication)
}

const SYNC_FOLDER_PROBE_BYTES: &[u8] = b"mindwtr sync folder probe\n";

fn sync_folder_probe_stage_error(stage: AtomicWriteStage, detail: &str) -> String {
    let message = match stage {
        AtomicWriteStage::Create => "Could not create a file in this folder",
        AtomicWriteStage::WriteAndSync => "Could not finish writing a file in this folder",
        AtomicWriteStage::Rename => "Could not finalize a file in this folder",
    };
    format!("{message}: {detail}")
}

fn probe_sync_dir_at_with<BeforeStage, ReadBack, BeforeRemove>(
    sync_dir: &Path,
    tmp_file: &Path,
    final_file: &Path,
    before_stage: &mut BeforeStage,
    read_back: &mut ReadBack,
    before_remove: &mut BeforeRemove,
) -> Result<(), String>
where
    BeforeStage: FnMut(AtomicWriteStage) -> Result<(), String>,
    ReadBack: FnMut(&Path, Vec<u8>) -> Result<Vec<u8>, String>,
    BeforeRemove: FnMut(&Path) -> Result<(), String>,
{
    let sync_lock = match acquire_sync_lock(sync_dir) {
        Ok(sync_lock) => sync_lock,
        Err(error) => {
            return Err(sync_folder_probe_stage_error(
                AtomicWriteStage::Create,
                &error,
            ));
        }
    };
    let root = RetainedSyncRoot::new(sync_dir, &sync_lock);

    let result = (|| -> Result<(), String> {
        revalidate_sync_lock(&sync_lock, sync_dir).map_err(|error| {
            sync_folder_probe_stage_error(AtomicWriteStage::Create, &error)
        })?;
        let mut guarded_before_stage = |stage: AtomicWriteStage| {
            before_stage(stage)?;
            revalidate_sync_lock(&sync_lock, sync_dir)
        };
        let publication = atomic_retained_tmp_write_then_rename_with(
            &root,
            tmp_file,
            final_file,
            SYNC_FOLDER_PROBE_BYTES,
            &mut guarded_before_stage,
            None,
            false,
        )
        .map_err(|error| sync_folder_probe_stage_error(error.stage, &error.detail))?;

        revalidate_sync_lock(&sync_lock, sync_dir)
            .map_err(|error| format!("Wrote a file but could not read it back: {error}"))?;
        let actual = publication
            .read_back(final_file)
            .map_err(|error| format!("Wrote a file but could not read it back: {error}"))?;
        let actual = read_back(final_file, actual)
            .map_err(|error| format!("Wrote a file but could not read it back: {error}"))?;
        if actual != SYNC_FOLDER_PROBE_BYTES {
            return Err(
                "Wrote a file but could not read it back: contents did not match".to_string(),
            );
        }

        revalidate_sync_lock(&sync_lock, sync_dir)
            .map_err(|error| format!("Could not remove the test file: {error}"))?;
        publication.remove_with(final_file, before_remove)
            .map_err(|error| format!("Could not remove the test file: {error}"))
    })();

    // Failed write stages clean up only the exact temp identity they created.
    // A failed final delete is retried by the publication owner inside the
    // successful-write branch above; unowned pre-existing leaves are untouched.
    release_sync_lock(&sync_lock);
    result
}

fn probe_sync_dir_at(sync_dir: &Path, tmp_file: &Path, final_file: &Path) -> Result<(), String> {
    let mut before_stage = |_stage: AtomicWriteStage| Ok(());
    let mut read_back = |_path: &Path, bytes: Vec<u8>| Ok(bytes);
    let mut before_remove = |_path: &Path| Ok(());

    probe_sync_dir_at_with(
        sync_dir,
        tmp_file,
        final_file,
        &mut before_stage,
        &mut read_back,
        &mut before_remove,
    )
}

fn probe_sync_dir(sync_dir: &Path) -> Result<(), String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let base = format!(
        ".mindwtr-folder-probe-{}-{nonce}",
        std::process::id()
    );
    let tmp_file = sync_dir.join(format!("{base}.tmp"));
    let final_file = sync_dir.join(base);
    probe_sync_dir_at(sync_dir, &tmp_file, &final_file)
}

#[cfg(test)]
fn finish_copied_sync_file_durably<SyncFile, Remove, SyncParent>(
    tmp_file: &Path,
    sync_file: &Path,
    mut sync_file_contents: SyncFile,
    mut remove: Remove,
    mut sync_parent: SyncParent,
) -> Result<(), String>
where
    SyncFile: FnMut(&Path) -> std::io::Result<()>,
    Remove: FnMut(&Path) -> std::io::Result<()>,
    SyncParent: FnMut(&Path) -> std::io::Result<()>,
{
    sync_file_contents(sync_file)
        .map_err(|error| format!("Failed to flush copied sync file: {error}"))?;
    remove(tmp_file).map_err(|error| format!("Failed to remove copied sync temp file: {error}"))?;
    sync_parent(sync_file)
        .map_err(|error| format!("Failed to flush sync directory metadata: {error}"))
}

#[cfg(test)]
fn replace_file_preserving_previous<Remove, Rename>(
    replacement: &Path,
    target: &Path,
    previous: &Path,
    description: &str,
    mut remove: Remove,
    mut rename: Rename,
) -> Result<(), String>
where
    Remove: FnMut(&Path) -> std::io::Result<()>,
    Rename: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    if previous.exists() {
        remove(previous).map_err(|error| {
            format!("Failed to clear the previous {description} recovery file: {error}")
        })?;
    }

    rename(target, previous)
        .map_err(|error| format!("Failed to preserve the current {description}: {error}"))?;

    match rename(replacement, target) {
        Ok(()) => {
            let _ = remove(previous);
            Ok(())
        }
        Err(replace_error) => match rename(previous, target) {
            Ok(()) => Err(format!(
                "Failed to install the replacement {description}; restored the previous {description}: {replace_error}"
            )),
            Err(restore_error) => Err(format!(
                "Failed to install the replacement {description} ({replace_error}); the previous {description} remains at {} because restoration also failed: {restore_error}",
                previous.display()
            )),
        },
    }
}

#[cfg(test)]
fn replace_sync_backup_preserving_previous<Remove, Rename>(
    replacement: &Path,
    target: &Path,
    previous: &Path,
    remove: Remove,
    rename: Rename,
) -> Result<(), String>
where
    Remove: FnMut(&Path) -> std::io::Result<()>,
    Rename: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    replace_file_preserving_previous(replacement, target, previous, "sync backup", remove, rename)
}

#[cfg(test)]
fn replace_sync_file_preserving_previous<Remove, Rename>(
    replacement: &Path,
    target: &Path,
    previous: &Path,
    remove: Remove,
    rename: Rename,
) -> Result<(), String>
where
    Remove: FnMut(&Path) -> std::io::Result<()>,
    Rename: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    replace_file_preserving_previous(replacement, target, previous, "sync file", remove, rename)
}

fn replace_retained_file_preserving_previous<Validate>(
    root: &RetainedSyncRoot<'_>,
    replacement: &Path,
    target: &Path,
    previous: &Path,
    description: &str,
    validate: &mut Validate,
) -> Result<(), String>
where
    Validate: FnMut() -> Result<(), String> + ?Sized,
{
    if root.exists(previous).map_err(|error| error.to_string())? {
        validate()?;
        root.remove(previous).map_err(|error| {
            format!("Failed to clear the previous {description} recovery file: {error}")
        })?;
        validate()?;
    }

    let target_was_present = root.exists(target).map_err(|error| error.to_string())?;
    if target_was_present {
        validate()?;
        root.rename(target, previous, false)
            .map_err(|error| format!("Failed to preserve the current {description}: {error}"))?;
        validate()?;
    }

    validate()?;
    match root.rename(replacement, target, false) {
        Ok(()) => {
            validate()?;
            if target_was_present {
                validate()?;
                root.remove(previous).map_err(|error| {
                    format!("Failed to clear the installed {description} recovery file: {error}")
                })?;
                validate()?;
            }
            Ok(())
        }
        Err(replace_error) if !target_was_present => Err(format!(
            "Failed to install the replacement {description}: {replace_error}"
        )),
        Err(replace_error) => {
            validate()?;
            let restore = root.rename(previous, target, false);
            if restore.is_ok() {
                validate()?;
            }
            match restore {
            Ok(()) => Err(format!(
                "Failed to install the replacement {description}; restored the previous {description}: {replace_error}"
            )),
            Err(restore_error) => Err(format!(
                "Failed to install the replacement {description} ({replace_error}); the previous {description} remains at {} because restoration also failed: {restore_error}",
                previous.display()
            )),
            }
        }
    }
}

/// How the file backend should treat the bytes on disk for this operation. `Off` is the
/// pre-feature path and must stay byte-for-byte identical to it (backward-compat invariant #1):
/// same filenames, same recovery chain, same errors, no extra IO.
#[derive(Clone, Copy)]
pub(crate) enum SyncFileCrypto<'a> {
    Off,
    Enabled(&'a SyncKeyMaterial),
}

impl<'a> SyncFileCrypto<'a> {
    fn material(self) -> Option<&'a SyncKeyMaterial> {
        match self {
            Self::Off => None,
            Self::Enabled(material) => Some(material),
        }
    }

    fn is_on(self) -> bool {
        matches!(self, Self::Enabled(_))
    }

    /// The base document name every sibling path is derived from: `data.json` when off,
    /// `data.json.enc` when on. `.bak`/`.tmp`/`.previous` still append to it, which is exactly
    /// core's `syncEncryptedArtifactName` mapping (`data.json.bak` -> `data.json.enc.bak`).
    fn data_base(self) -> String {
        if self.is_on() {
            encrypted_artifact_name(DATA_FILE_NAME)
        } else {
            DATA_FILE_NAME.to_string()
        }
    }
}

fn sync_payload_is_valid(value: &Value) -> Result<(), String> {
    let validate = |value: &Value| -> Result<(), String> {
        let Some(object) = value.as_object() else {
            return Err("Invalid sync payload shape: expected an object".to_string());
        };
        for surface in ["tasks", "projects", "sections", "areas", "people"] {
            let Some(entities) = object.get(surface) else {
                continue;
            };
            let Some(entities) = entities.as_array() else {
                return Err(format!(
                    "Invalid sync payload shape: {surface} must be an array when present"
                ));
            };
            for (index, entity) in entities.iter().enumerate() {
                let Some(entity) = entity.as_object() else {
                    return Err(format!(
                        "Invalid sync payload shape: {surface}[{index}] must be an object"
                    ));
                };
                if !entity
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.trim().is_empty())
                {
                    return Err(format!(
                        "Invalid sync payload shape: {surface}[{index}].id must be a non-empty string"
                    ));
                }
            }
        }
        if object
            .get("settings")
            .is_some_and(|entry| !entry.is_object())
        {
            return Err(
                "Invalid sync payload shape: settings must be an object when present".to_string(),
            );
        }
        Ok(())
    };
    validate(value)
}

fn normalize_sync_document_value(value: Value) -> Value {
    let Value::Object(mut map) = value else {
        return empty_remote_app_data();
    };
    for surface in ["tasks", "projects", "areas", "sections", "people"] {
        if !matches!(map.get(surface), Some(Value::Array(_))) {
            map.insert(surface.to_string(), Value::Array(Vec::new()));
        }
    }
    if !matches!(map.get("settings"), Some(Value::Object(_))) {
        map.insert("settings".to_string(), serde_json::Map::new().into());
    }
    Value::Object(map)
}

fn read_sync_candidate(path: &Path, attempts: usize) -> Result<Value, String> {
    read_json_with_retries_validated(path, attempts, sync_payload_is_valid)
}

/// Decrypt-then-validate. A decrypt failure is a TERMINAL error, never "invalid JSON, try the
/// next recovery candidate": ciphertext this device cannot open may be a peer's perfectly good
/// newer generation, or simply the wrong passphrase. Fail closed — the caller stops the run,
/// nothing is rotated, nothing is repaired, nothing is deleted (pinned decision #4).
fn read_encrypted_sync_candidate(
    path: &Path,
    attempts: usize,
    material: &SyncKeyMaterial,
) -> Result<Value, String> {
    read_json_with_retries_decoded(
        path,
        attempts,
        |path| {
            let bytes = fs::read(path).map_err(|error| error.to_string())?;
            if let Some(discovery) = foreign_salt_discovery(&bytes, material) {
                return Err(discovery);
            }
            let plaintext = decrypt_sync_artifact(&bytes, &material.key)
                .map_err(|error| terminal_error(error))?;
            String::from_utf8(plaintext)
                .map_err(|error| terminal_error(format!("decrypted sync payload is not UTF-8: {error}")))
        },
        sync_payload_is_valid,
    )
}

fn read_sync_candidate_with(
    path: &Path,
    attempts: usize,
    crypto: SyncFileCrypto<'_>,
) -> Result<Value, String> {
    match crypto.material() {
        None => read_sync_candidate(path, attempts),
        Some(material) => read_encrypted_sync_candidate(path, attempts, material),
    }
}

fn read_sync_candidate_bytes_with(
    bytes: &[u8],
    crypto: SyncFileCrypto<'_>,
) -> Result<Value, String> {
    let plaintext = match crypto.material() {
        None => String::from_utf8(bytes.to_vec()).map_err(|error| error.to_string())?,
        Some(material) => {
            if let Some(discovery) = foreign_salt_discovery(bytes, material) {
                return Err(discovery);
            }
            let plaintext = decrypt_sync_artifact(bytes, &material.key)
                .map_err(|error| terminal_error(error))?;
            String::from_utf8(plaintext).map_err(|error| {
                terminal_error(format!("decrypted sync payload is not UTF-8: {error}"))
            })?
        }
    };
    let mut sanitized = plaintext
        .trim_start_matches('\u{FEFF}')
        .trim_end()
        .to_string();
    while sanitized.ends_with('\u{0}') {
        sanitized.pop();
    }
    if sanitized.is_empty() {
        sanitized.push_str("{}");
    }
    let value = match serde_json::from_str::<Value>(&sanitized) {
        Ok(value) => value,
        Err(_) => {
            let start = sanitized
                .find(|character| character == '{' || character == '[')
                .unwrap_or(0);
            let mut deserializer = serde_json::Deserializer::from_str(&sanitized[start..]);
            Value::deserialize(&mut deserializer).map_err(|error| error.to_string())?
        }
    };
    sync_payload_is_valid(&value)?;
    Ok(normalize_sync_document_value(value))
}

fn read_sync_candidate_from_retained_root(
    root: &RetainedSyncRoot<'_>,
    path: &Path,
    attempts: usize,
    crypto: SyncFileCrypto<'_>,
) -> Result<Value, String> {
    let mut read_bytes = |path: &Path| root.read(path).map_err(|error| error.to_string());
    let mut wait = |duration| std::thread::sleep(duration);
    read_sync_candidate_from_retained_root_with(
        path,
        attempts,
        crypto,
        &mut read_bytes,
        &mut wait,
    )
}

fn read_sync_candidate_from_retained_root_with<ReadBytes, Wait>(
    path: &Path,
    attempts: usize,
    crypto: SyncFileCrypto<'_>,
    read_bytes: &mut ReadBytes,
    wait: &mut Wait,
) -> Result<Value, String>
where
    ReadBytes: FnMut(&Path) -> Result<Vec<u8>, String>,
    Wait: FnMut(Duration),
{
    let mut last_error = None;
    for attempt in 0..attempts {
        if is_icloud_evicted(path) {
            last_error = Some("File is iCloud-evicted (placeholder only)".to_string());
        } else {
            match read_bytes(path)
                .and_then(|bytes| read_sync_candidate_bytes_with(&bytes, crypto))
            {
                Ok(value) => return Ok(value),
                Err(error) => last_error = Some(error),
            }
        }
        if attempt + 1 < attempts {
            wait(Duration::from_millis(120 + (attempt as u64) * 80));
        }
    }
    Err(last_error.unwrap_or_else(|| "Failed to read sync file".to_string()))
}

fn retained_seed_backup_files(
    root: &RetainedSyncRoot<'_>,
    seed_suffix: &str,
) -> Result<Vec<PathBuf>, String> {
    let names = root.list_direct_child_names().map_err(|error| {
        format!("Failed to enumerate retained File Sync root: {error}")
    })?;
    let mut candidates: Vec<(SystemTime, String, PathBuf)> = Vec::new();
    for name in names {
        let Some(name_text) = name.to_str() else {
            continue;
        };
        let lower = name_text.to_ascii_lowercase();
        if !(lower.starts_with("mindwtr-backup-") || lower.starts_with("data-backup-"))
            || !lower.ends_with(seed_suffix)
        {
            continue;
        }
        let path = root.sync_dir.join(&name);
        let file = root.open_read(&path).map_err(|error| {
            format!("Failed to inspect retained File Sync seed candidate: {error}")
        })?;
        let modified = file
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);
        candidates.push((modified, lower, path));
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    Ok(candidates
        .into_iter()
        .map(|(_, _, path)| path)
        .collect())
}

fn read_sync_file_from_retained_root_with(
    root: &RetainedSyncRoot<'_>,
    crypto: SyncFileCrypto<'_>,
) -> Result<Value, String> {
    let data_base = crypto.data_base();
    let primary = root.sync_dir.join(&data_base);
    let primary_previous = root.sync_dir.join(format!("{data_base}.previous"));
    let backup = root.sync_dir.join(format!("{data_base}.bak"));
    let backup_previous = root.sync_dir.join(format!("{data_base}.bak.previous"));
    let legacy_name = format!("{}-sync.json", APP_NAME);
    let legacy = root.sync_dir.join(if crypto.is_on() {
        encrypted_artifact_name(&legacy_name)
    } else {
        legacy_name
    });

    let seed_suffix = if crypto.is_on() { ".json.enc" } else { ".json" };
    let read_recovery = || -> Result<Option<Value>, String> {
        for path in [&primary_previous, &backup, &backup_previous] {
            if !root.exists(path).map_err(|error| error.to_string())? {
                continue;
            }
            match read_sync_candidate_from_retained_root(root, path, 2, crypto) {
                Ok(data) => return Ok(Some(data)),
                Err(error) if is_terminal_error(&error) => return Err(error),
                Err(_) => continue,
            }
        }
        Ok(None)
    };
    let read_seed_or_legacy = || -> Result<Option<Value>, String> {
        let mut first_error = None;
        if root.exists(&legacy).map_err(|error| error.to_string())? {
            match read_sync_candidate_from_retained_root(root, &legacy, 1, crypto) {
                Ok(data) => return Ok(Some(data)),
                Err(error) if is_terminal_error(&error) => return Err(error),
                Err(error) => first_error = Some(error),
            }
        }
        for seed in retained_seed_backup_files(root, seed_suffix)? {
            match read_sync_candidate_from_retained_root(root, &seed, 1, crypto) {
                Ok(data) => return Ok(Some(data)),
                Err(error) if is_terminal_error(&error) => return Err(error),
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(None),
        }
    };
    let detect_opposite_generation = || -> Result<Option<String>, String> {
        if !crypto.is_on() {
            let encrypted = root
                .sync_dir
                .join(encrypted_artifact_name(DATA_FILE_NAME));
            if root.exists(&encrypted).map_err(|error| error.to_string())? {
                let bytes = root.read(&encrypted).map_err(|error| error.to_string())?;
                return Ok(match inspect_sync_artifact(&bytes) {
                    SyncArtifactInspection::Encrypted(header) => {
                        Some(encrypted_discovery_marker(&header))
                    }
                    SyncArtifactInspection::Unsupported(reason) => Some(terminal_error(reason)),
                    SyncArtifactInspection::Plaintext => None,
                });
            }
        } else {
            let plaintext = root.sync_dir.join(DATA_FILE_NAME);
            if root.exists(&plaintext).map_err(|error| error.to_string())?
                && is_plaintext_sync_artifact(
                    &root.read(&plaintext).map_err(|error| error.to_string())?,
                )
            {
                return Ok(Some(SYNC_ENCRYPTION_REMOTE_PLAINTEXT.to_string()));
            }
        }
        Ok(None)
    };

    if is_icloud_evicted(&primary) {
        if let Some(data) = read_recovery()? {
            return Ok(data);
        }
        if let Some(data) = read_seed_or_legacy()? {
            return Ok(data);
        }
        return Err(format!(
            "Sync file has been offloaded by iCloud Optimize Storage. Open Finder and navigate to {:?} to trigger a re-download, then try again.",
            root.sync_dir
        ));
    }

    if !root.exists(&primary).map_err(|error| error.to_string())? {
        if let Some(data) = read_recovery()? {
            return Ok(data);
        }
        if let Some(data) = read_seed_or_legacy()? {
            return Ok(data);
        }
        if let Some(discovery) = detect_opposite_generation()? {
            return Err(discovery);
        }
        return Ok(empty_remote_app_data());
    }

    match read_sync_candidate_from_retained_root(root, &primary, 5, crypto) {
        Ok(data) => Ok(data),
        Err(primary_error) if is_terminal_error(&primary_error) => Err(primary_error),
        Err(primary_error) => {
            if !crypto.is_on() {
                let bytes = root.read(&primary).map_err(|error| error.to_string())?;
                match inspect_sync_artifact(&bytes) {
                    SyncArtifactInspection::Encrypted(header) => {
                        return Err(encrypted_discovery_marker(&header));
                    }
                    SyncArtifactInspection::Unsupported(reason) => {
                        return Err(terminal_error(reason));
                    }
                    SyncArtifactInspection::Plaintext => {}
                }
            }
            if let Some(data) = read_recovery()? {
                return Ok(data);
            }
            Err(primary_error)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SyncFileReadSource {
    Primary,
    PrimaryPrevious,
    Backup,
    BackupPrevious,
    Legacy,
    Seed,
    Empty,
}

impl SyncFileReadSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::PrimaryPrevious => "primaryPrevious",
            Self::Backup => "backup",
            Self::BackupPrevious => "backupPrevious",
            Self::Legacy => "legacy",
            Self::Seed => "seed",
            Self::Empty => "empty",
        }
    }

    fn needs_repair(self) -> bool {
        !matches!(self, Self::Primary | Self::Empty)
    }
}

#[derive(Debug)]
struct SyncFileRead {
    data: Value,
    source: SyncFileReadSource,
}

/// `Ok(None)` means "no usable candidate here, keep walking the chain". `Err` is reserved for
/// the terminal encryption class, which must stop the walk instead of degrading into a
/// recovery/repair (decision #4).
fn read_sync_backup(
    backup_file: &Path,
    previous_file: &Path,
    crypto: SyncFileCrypto<'_>,
) -> Result<Option<SyncFileRead>, String> {
    for (path, source) in [
        (backup_file, SyncFileReadSource::Backup),
        (previous_file, SyncFileReadSource::BackupPrevious),
    ] {
        if !path.exists() {
            continue;
        }
        match read_sync_candidate_with(path, 2, crypto) {
            Ok(data) => return Ok(Some(SyncFileRead { data, source })),
            Err(error) if is_terminal_error(&error) => return Err(error),
            Err(_) => continue,
        }
    }
    Ok(None)
}

fn read_sync_recovery(
    primary_previous_file: &Path,
    backup_file: &Path,
    backup_previous_file: &Path,
    crypto: SyncFileCrypto<'_>,
) -> Result<Option<SyncFileRead>, String> {
    if primary_previous_file.exists() {
        match read_sync_candidate_with(primary_previous_file, 2, crypto) {
            Ok(data) => {
                return Ok(Some(SyncFileRead {
                    data,
                    source: SyncFileReadSource::PrimaryPrevious,
                }))
            }
            Err(error) if is_terminal_error(&error) => return Err(error),
            Err(_) => {}
        }
    }
    read_sync_backup(backup_file, backup_previous_file, crypto)
}

/// Encryption-off shorthand. Only the tests still call it directly; every command resolves
/// this device's posture first and goes through the `_with` form.
#[cfg(test)]
fn read_sync_file_with_source_from_dir(sync_dir: &Path) -> Result<SyncFileRead, String> {
    read_sync_file_with_source_from_dir_with(sync_dir, SyncFileCrypto::Off)
}

fn read_sync_file_with_source_from_dir_with(
    sync_dir: &Path,
    crypto: SyncFileCrypto<'_>,
) -> Result<SyncFileRead, String> {
    let data_base = crypto.data_base();
    let sync_file = sync_dir.join(&data_base);
    let primary_previous_file = sync_dir.join(format!("{data_base}.previous"));
    let backup_file = sync_dir.join(format!("{data_base}.bak"));
    let backup_previous_file = sync_dir.join(format!("{data_base}.bak.previous"));
    let legacy_name = format!("{}-sync.json", APP_NAME);
    let legacy_sync_file = sync_dir.join(if crypto.is_on() {
        encrypted_artifact_name(&legacy_name)
    } else {
        legacy_name
    });
    // Seed backups the transition converted keep their base name plus `.enc`; an off-state
    // device keeps looking at exactly the `.json` names it always did.
    let seed_suffix = if crypto.is_on() { ".json.enc" } else { ".json" };

    let find_seed_backup_files = |dir: &Path| -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut candidates: Vec<(SystemTime, String, PathBuf)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let lower = name.to_ascii_lowercase();
            if !(lower.starts_with("mindwtr-backup-") || lower.starts_with("data-backup-")) {
                continue;
            }
            if !lower.ends_with(seed_suffix) {
                continue;
            }
            let modified = fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            candidates.push((modified, lower, path));
        }
        candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
        candidates.into_iter().map(|(_, _, path)| path).collect()
    };

    let read_seed_or_legacy_file = || -> Option<Result<SyncFileRead, String>> {
        let mut first_error: Option<String> = None;
        if legacy_sync_file.exists() {
            match read_sync_candidate_with(&legacy_sync_file, 1, crypto) {
                Ok(data) => {
                    return Some(Ok(SyncFileRead {
                        data,
                        source: SyncFileReadSource::Legacy,
                    }));
                }
                Err(error) if is_terminal_error(&error) => return Some(Err(error)),
                Err(error) => first_error = Some(error),
            }
        }
        for seed_file in find_seed_backup_files(sync_dir) {
            match read_sync_candidate_with(&seed_file, 1, crypto) {
                Ok(data) => {
                    return Some(Ok(SyncFileRead {
                        data,
                        source: SyncFileReadSource::Seed,
                    }));
                }
                Err(error) if is_terminal_error(&error) => return Some(Err(error)),
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        first_error.map(Err)
    };

    if is_icloud_evicted(&sync_file) {
        let msg = format!(
            "Sync file has been offloaded by iCloud Optimize Storage. \
             Open Finder and navigate to {:?} to trigger a re-download, then try again.",
            sync_dir
        );
        log::warn!("{}", msg);
        if let Some(value) = read_sync_recovery(
            &primary_previous_file,
            &backup_file,
            &backup_previous_file,
            crypto,
        )? {
            return Ok(value);
        }
        if let Some(result) = read_seed_or_legacy_file() {
            return result;
        }
        return Err(msg);
    }

    if !sync_file.exists() {
        if let Some(value) = read_sync_recovery(
            &primary_previous_file,
            &backup_file,
            &backup_previous_file,
            crypto,
        )? {
            return Ok(value);
        }
        if let Some(result) = read_seed_or_legacy_file() {
            return result;
        }
        // Detection (decision #2): only once the whole chain for THIS device's generation has
        // come up empty — which is exactly the "first sync" / "a peer flipped encryption at
        // the sync location" shape. A populated folder never gets here, so an existing install
        // pays no extra IO for this (invariant #1). Off-state looks for ciphertext; a keyed
        // device looks for the plaintext a peer's disable transition restored, because
        // treating that as an empty remote would merge into a fresh generation and fork.
        if !crypto.is_on() {
            if let Some(discovery) = detect_encrypted_sync_document(sync_dir)? {
                return Err(discovery);
            }
        } else if plaintext_sync_document_exists(sync_dir)? {
            return Err(SYNC_ENCRYPTION_REMOTE_PLAINTEXT.to_string());
        }
        return Ok(SyncFileRead {
            data: empty_remote_app_data(),
            source: SyncFileReadSource::Empty,
        });
    }

    match read_sync_candidate_with(&sync_file, 5, crypto) {
        Ok(data) => Ok(SyncFileRead {
            data,
            source: SyncFileReadSource::Primary,
        }),
        Err(primary_err) => {
            if is_terminal_error(&primary_err) {
                return Err(primary_err);
            }
            // A plain-named file whose bytes are MWENC1 is not "invalid JSON to repair"
            // (decision #4) — classify it before the recovery chain can rotate anything.
            if !crypto.is_on() {
                if let Some(discovery) = classify_encrypted_bytes(&sync_file)? {
                    return Err(discovery);
                }
            }
            if let Some(value) = read_sync_recovery(
                &primary_previous_file,
                &backup_file,
                &backup_previous_file,
                crypto,
            )? {
                return Ok(value);
            }
            Err(primary_err)
        }
    }
}

/// Encodes an MWENC1 discovery as `SYNC_ENCRYPTION_REMOTE_ENCRYPTED:<saltHex>:<mKib>:<t>:<p>`.
/// The command layer parses it, persists `remote-encrypted-no-key`, and hands TS the bare
/// sentinel — keeping the AppHandle-free `*_from_dir` functions directly unit-testable.
fn read_sync_artifact_if_present(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to inspect sync artifact {}: {error}",
            path.display()
        )),
    }
}

fn classify_encrypted_bytes(path: &Path) -> Result<Option<String>, String> {
    let Some(bytes) = read_sync_artifact_if_present(path)? else {
        return Ok(None);
    };
    Ok(match inspect_sync_artifact(&bytes) {
        SyncArtifactInspection::Encrypted(header) => Some(encrypted_discovery_marker(&header)),
        // A header that is present but unreadable is still never "repair me".
        SyncArtifactInspection::Unsupported(reason) => Some(terminal_error(reason)),
        SyncArtifactInspection::Plaintext => None,
    })
}

/// True when a non-empty, non-MWENC1 sync document sits at the plaintext name. Mirrors core's
/// `isPlaintextSyncArtifact`; an empty or whitespace-only file is evidence of nothing.
fn plaintext_sync_document_exists(sync_dir: &Path) -> Result<bool, String> {
    Ok(read_sync_artifact_if_present(&sync_dir.join(DATA_FILE_NAME))?
        .is_some_and(|bytes| is_plaintext_sync_artifact(&bytes)))
}

fn detect_encrypted_sync_document(sync_dir: &Path) -> Result<Option<String>, String> {
    let encrypted = sync_dir.join(encrypted_artifact_name(DATA_FILE_NAME));
    classify_encrypted_bytes(&encrypted)
}

pub(crate) fn parse_encrypted_discovery(error: &str) -> Option<([u8; SALT_LEN], SyncCryptoKdfParams)> {
    let rest = error.strip_prefix(SYNC_ENCRYPTION_REMOTE_ENCRYPTED)?.strip_prefix(':')?;
    let mut parts = rest.split(':');
    let salt = <[u8; SALT_LEN]>::try_from(hex_to_bytes(parts.next()?)?.as_slice()).ok()?;
    let m_kib = parts.next()?.parse().ok()?;
    let t = parts.next()?.parse().ok()?;
    let p = parts.next()?.parse().ok()?;
    Some((salt, SyncCryptoKdfParams { m_kib, t, p }))
}

#[cfg(test)]
fn read_sync_file_from_dir(sync_dir: &Path) -> Result<serde_json::Value, String> {
    read_sync_file_with_source_from_dir(sync_dir).map(|result| result.data)
}

fn read_sync_file_from_dir_with(
    sync_dir: &Path,
    crypto: SyncFileCrypto<'_>,
) -> Result<serde_json::Value, String> {
    read_sync_file_with_source_from_dir_with(sync_dir, crypto).map(|result| result.data)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncFileReadResult {
    data: Value,
    fingerprint: String,
    source: &'static str,
    needs_repair: bool,
}

fn sync_document_fingerprint(data: &Value) -> Result<String, String> {
    let serialized = serde_json::to_vec(data)
        .map_err(|error| format!("Failed to fingerprint sync data: {error}"))?;
    Ok(format!(
        "file:v1:sha256={}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(serialized))
    ))
}

#[cfg(test)]
fn read_sync_file_versioned_from_dir(sync_dir: &Path) -> Result<SyncFileReadResult, String> {
    read_sync_file_versioned_from_dir_with(sync_dir, SyncFileCrypto::Off)
}

fn read_sync_file_versioned_from_dir_with(
    sync_dir: &Path,
    crypto: SyncFileCrypto<'_>,
) -> Result<SyncFileReadResult, String> {
    let result = read_sync_file_with_source_from_dir_with(sync_dir, crypto)?;
    let fingerprint = sync_document_fingerprint(&result.data)?;
    Ok(SyncFileReadResult {
        data: result.data,
        fingerprint,
        source: result.source.as_str(),
        needs_repair: result.source.needs_repair(),
    })
}

/// Resolves this device's encryption posture for a file-backend operation. Enabled-but-no-key
/// fails closed rather than silently reading/writing the plaintext names, which would fork the
/// folder into two generations.
fn resolve_sync_encryption_material(app: &tauri::AppHandle) -> Result<Option<SyncKeyMaterial>, String> {
    if !is_encryption_enabled(app)? {
        return Ok(None);
    }
    resolve_key_material(app)?
        .map(Some)
        .ok_or_else(|| terminal_error("sync encryption is enabled but no key is available on this device"))
}

fn crypto_for<'a>(material: &'a Option<SyncKeyMaterial>) -> SyncFileCrypto<'a> {
    match material {
        Some(material) => SyncFileCrypto::Enabled(material),
        None => SyncFileCrypto::Off,
    }
}

/// Turns an in-band discovery marker into persisted `remote-encrypted-no-key` state plus the
/// bare sentinel TS classifies on. Anything else passes through untouched.
fn persist_discovery_and_reduce<T>(
    app: &tauri::AppHandle,
    result: Result<T, String>,
) -> Result<T, String> {
    match result {
        Err(error) => {
            if let Some((salt, params)) = parse_encrypted_discovery(&error) {
                mark_remote_encrypted_no_key(app, &salt, params)?;
                return Err(SYNC_ENCRYPTION_REMOTE_ENCRYPTED.to_string());
            }
            if error == SYNC_ENCRYPTION_REMOTE_PLAINTEXT {
                mark_remote_plaintext(app)?;
            }
            Err(error)
        }
        ok => ok,
    }
}

#[tauri::command(async)]
pub(crate) fn read_sync_file(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let sync_dir = match path {
        Some(path) => resolve_sync_dir_granting_scope(&app, path)?,
        None => {
            configured_sync_dir(&app)?.ok_or_else(|| "Sync path is not configured".to_string())?
        }
    };
    let material = resolve_sync_encryption_material(&app)?;
    persist_discovery_and_reduce(
        &app,
        read_sync_file_from_dir_with(&sync_dir, crypto_for(&material)),
    )
}

#[tauri::command(async)]
pub(crate) fn read_sync_file_versioned(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<SyncFileReadResult, String> {
    let sync_dir = match path {
        Some(path) => resolve_sync_dir_granting_scope(&app, path)?,
        None => {
            configured_sync_dir(&app)?.ok_or_else(|| "Sync path is not configured".to_string())?
        }
    };
    let material = resolve_sync_encryption_material(&app)?;
    persist_discovery_and_reduce(
        &app,
        read_sync_file_versioned_from_dir_with(&sync_dir, crypto_for(&material)),
    )
}

#[cfg(test)]
fn write_sync_file_to_dir(
    sync_dir: &Path,
    data: Value,
    expected_fingerprint: Option<&str>,
) -> Result<bool, String> {
    write_sync_file_to_dir_with(sync_dir, data, expected_fingerprint, SyncFileCrypto::Off)
}

fn write_sync_file_to_dir_with(
    sync_dir: &Path,
    data: Value,
    expected_fingerprint: Option<&str>,
    crypto: SyncFileCrypto<'_>,
) -> Result<bool, String> {
    write_sync_file_to_dir_with_lease(sync_dir, data, expected_fingerprint, crypto, None)
}

fn write_sync_file_to_dir_with_lease(
    sync_dir: &Path,
    data: Value,
    expected_fingerprint: Option<&str>,
    crypto: SyncFileCrypto<'_>,
    existing_sync_lock: Option<&SyncFileLock>,
) -> Result<bool, String> {
    let mut validate_existing_lease = || Ok(());
    write_sync_file_to_dir_with_lease_and_validation(
        sync_dir,
        data,
        expected_fingerprint,
        crypto,
        existing_sync_lock,
        &mut validate_existing_lease,
    )
}

fn write_sync_file_to_dir_with_lease_and_validation<ValidateLease>(
    sync_dir: &Path,
    data: Value,
    expected_fingerprint: Option<&str>,
    crypto: SyncFileCrypto<'_>,
    existing_sync_lock: Option<&SyncFileLock>,
    validate_existing_lease: &mut ValidateLease,
) -> Result<bool, String>
where
    ValidateLease: FnMut() -> Result<(), String>,
{
    let data_base = crypto.data_base();
    let sync_file = sync_dir.join(&data_base);
    let backup_file = sync_dir.join(format!("{data_base}.bak"));
    let backup_previous_file = sync_dir.join(format!("{data_base}.bak.previous"));
    let primary_previous_file = sync_dir.join(format!("{data_base}.previous"));
    let tmp_file = sync_dir.join(format!("{data_base}.tmp"));

    if is_icloud_evicted(&sync_file) {
        log::warn!(
            "Sync target is iCloud-evicted; writing directly to avoid corrupting placeholder."
        );
    }

    let sync_lock = if existing_sync_lock.is_some() {
        None
    } else {
        Some(acquire_sync_lock(sync_dir)?)
    };
    let authority_lock = existing_sync_lock
        .or(sync_lock.as_ref())
        .ok_or_else(|| "File Sync write has no retained root authority".to_string())?;
    let root = RetainedSyncRoot::new(sync_dir, authority_lock);

    let result = (|| -> Result<bool, String> {
        let mut validate_authority = || {
            validate_existing_lease()?;
            revalidate_sync_lock(authority_lock, sync_dir)
        };
        validate_authority()?;
        if let Some(expected_fingerprint) = expected_fingerprint {
            // Fingerprints stay plaintext-domain: the read below decrypts first, so the same
            // document fingerprints identically before and after a re-encryption (decision #9).
            let current = read_sync_file_from_retained_root_with(&root, crypto)?;
            let current_fingerprint = sync_document_fingerprint(&current)?;
            if current_fingerprint != expected_fingerprint {
                return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
            }
        }

        let existing_primary = if root.exists(&sync_file).map_err(|error| error.to_string())? {
            match read_sync_candidate_from_retained_root(&root, &sync_file, 1, crypto) {
                Ok(_) => Some(true),
                // Fail closed: ciphertext we cannot open may be a peer's newer generation.
                // Refuse to write over it at all — do not rotate, do not overwrite, do not
                // "repair" (decision #4). Unlike a plain unparseable file, this is never a
                // corrupt-remote-we-should-replace signal.
                Err(error) if is_terminal_error(&error) => return Err(error),
                Err(_) => Some(false),
            }
        } else {
            None
        };

        if existing_primary == Some(true) {
            // Overwriting the backup in place needs O_TRUNC, which rclone/WinFSP
            // mounts refuse without a VFS write cache — so the .bak silently
            // stopped updating there (#1001). Write a fresh temp name (a new
            // file, always allowed) and rename over the old backup, the same
            // shape the data file itself uses.
            let backup_tmp = sync_dir.join(format!("{data_base}.bak.tmp"));
            validate_authority()?;
            let backup_copy = (|| -> Result<(), String> {
                root.remove(&backup_tmp).map_err(|error| error.to_string())?;
                let primary_bytes = root.read(&sync_file).map_err(|error| error.to_string())?;
                root.write_new(&backup_tmp, &primary_bytes)
                    .map_err(|error| error.to_string())?;
                Ok(())
            })();
            validate_authority()?;
            if let Err(error) = backup_copy {
                log::warn!("Sync backup copy failed: {error}");
            } else {
                validate_authority()?;
                let replacement = if cfg!(windows)
                    && root
                        .exists(&backup_file)
                        .map_err(|error| error.to_string())?
                {
                    replace_retained_file_preserving_previous(
                        &root,
                        &backup_tmp,
                        &backup_file,
                        &backup_previous_file,
                        "sync backup",
                        &mut validate_authority,
                    )
                } else {
                    root.rename(&backup_tmp, &backup_file, true)
                        .map_err(|error| error.to_string())
                };
                let directory_flush = root.sync_directory().map_err(|error| {
                        format!("Failed to flush sync backup directory metadata: {error}")
                    });
                validate_authority()?;
                if let Err(err) = replacement.and(directory_flush) {
                    log::warn!("Sync backup replacement failed: {err}");
                }
            }
        }

        let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
        // Encryption wraps the already-serialized bytes and changes nothing above this line:
        // the document, its pretty-printing, and its fingerprint are all plaintext-domain.
        let content: Vec<u8> = match crypto.material() {
            None => content.into_bytes(),
            Some(material) => encrypt_sync_artifact(content.as_bytes(), material)
                .map_err(|error| terminal_error(error))?,
        };

        // This is the final boundary before any canonical document mutation.
        // A renderer-held lease supplies its retained root/legacy-lock validator;
        // a self-acquired write validates the lock it owns locally. The second
        // check below binds the reported success to the same authority.
        validate_authority()?;

        let windows_replacement = cfg!(windows)
            && root
                .exists(&sync_file)
                .map_err(|error| error.to_string())?;
        // Windows cannot rename over an existing destination. Move the primary
        // aside so a failed installation can roll back without depending on the
        // best-effort backup copy. New destinations use the helper's normal rename.
        let mut replace_existing = |
            retained_root: &RetainedSyncRoot<'_>,
            from: &Path,
            to: &Path,
            validate: &mut dyn FnMut() -> Result<(), String>,
        | {
            replace_retained_file_preserving_previous(
                retained_root,
                from,
                to,
                &primary_previous_file,
                "sync file",
                validate,
            )
        };
        let rename_override: Option<
            &mut dyn FnMut(
                &RetainedSyncRoot<'_>,
                &Path,
                &Path,
                &mut dyn FnMut() -> Result<(), String>,
            ) -> Result<(), String>,
        > = if windows_replacement {
            Some(&mut replace_existing)
        } else {
            None
        };

        let publication_result = {
            let mut before_stage = |_stage: AtomicWriteStage| validate_authority();
            atomic_retained_tmp_write_then_rename_with(
                &root,
                &tmp_file,
                &sync_file,
                &content,
                &mut before_stage,
                rename_override,
                true,
            )
        };
        let finalized = match publication_result {
            Ok(mut publication) => {
                publication.keep();
                validate_authority()?;
                root.sync_directory()
                    .map_err(|error| format!("Failed to flush sync directory metadata: {error}"))?;
                validate_authority()?;
                Ok(true)
            }
            Err(error) if error.stage != AtomicWriteStage::Rename || windows_replacement => {
                Err(error.detail)
            }
            Err(mut error) => {
                let rename_err = std::mem::take(&mut error.detail);
                let publication = error.owned_temp.take().ok_or_else(|| {
                    format!(
                        "Sync write failed: rename error: {rename_err}; the invocation-owned temp file is no longer available"
                    )
                })?;
                log::warn!(
                    "Atomic rename failed ({}), falling back to direct write",
                    rename_err
                );
                publication.verify_at(&tmp_file).map_err(|ownership_error| {
                    format!(
                        "Sync write failed: rename error: {rename_err}; temp ownership error: {ownership_error}"
                    )
                })?;
                validate_authority()?;
                match root.write_replace(&sync_file, &content) {
                    Ok(_) => {
                        validate_authority()?;
                        let mut before_remove = |_owned_path: &Path| Ok(());
                        publication.remove_with(&tmp_file, &mut before_remove)?;
                        root.sync_directory().map_err(|error| {
                            format!("Failed to flush sync directory metadata: {error}")
                        })?;
                        validate_authority()?;
                        Ok(true)
                    }
                    Err(copy_err) => Err(format!(
                        "Sync write failed: rename error: {rename_err}, copy fallback error: {copy_err}"
                    )),
                }
            }
        };

        if finalized.is_ok() {
            validate_authority()?;
        }
        finalized
    })();

    if let Some(sync_lock) = &sync_lock {
        release_sync_lock(sync_lock);
    }

    result
}

// Off the UI thread for the same reason as `read_sync_file`; concurrent writers
// are serialized by `acquire_sync_lock`, and stale readers are rejected by the
// expected fingerprint check while that lock is held.
#[tauri::command(async)]
pub(crate) fn write_sync_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    lease_state: tauri::State<'_, FileSyncLeaseState>,
    data: Value,
    path: Option<String>,
    expected_fingerprint: Option<String>,
    lease_token: Option<String>,
) -> Result<bool, String> {
    let sync_dir = match path {
        Some(path) => resolve_sync_dir_granting_scope(&app, path)?,
        None => {
            configured_sync_dir(&app)?.ok_or_else(|| "Sync path is not configured".to_string())?
        }
    };
    let material = resolve_sync_encryption_material(&app)?;
    if let Some(token) = lease_token {
        let normalized_sync_dir = normalize_lease_sync_dir(&sync_dir);
        return with_file_sync_lease(&lease_state, &token, window.label(), |lease| {
            if lease.sync_dir != normalized_sync_dir {
                return Err("File Sync lease does not belong to this sync folder".to_string());
            }
            let held_sync_dir = lease.sync_dir.clone();
            let mut validate_lease = || revalidate_sync_lock(&lease._sync_lock, &held_sync_dir);
            write_sync_file_to_dir_with_lease_and_validation(
                &held_sync_dir,
                data,
                expected_fingerprint.as_deref(),
                crypto_for(&material),
                Some(&lease._sync_lock),
                &mut validate_lease,
            )
        });
    }
    write_sync_file_to_dir_with(
        &sync_dir,
        data,
        expected_fingerprint.as_deref(),
        crypto_for(&material),
    )
}

// ---------------------------------------------------------------------------
// File-sync encryption transitions (#1056 decision #3).
//
// Explicit maintenance operations, never a sync-cycle side effect. They hold the same sync
// lock every write holds, they touch the REMOTE (sync-folder) artifact set only — local
// SQLite and the local attachments directory are never rewritten, so an interrupted or
// wrong-passphrase run always leaves the user's full local dataset intact — and every
// artifact is written, read back and decrypt-verified before its predecessor is removed, so
// a crash mid-run leaves both generations present and re-running resumes.
//
// WebDAV and Dropbox transitions do NOT come through here: they run core's shared
// `runEnableSyncEncryptionOverRemote` family from TS, because enumerating a remote's
// attachments is a TS-side concern (the sync document is the attachment index) and one
// shared implementation for those two backends beats a second Rust one. Rust still owns the
// per-cycle WebDAV crypto seam (`webdav_get_json`/`webdav_put_json`) below.
// ---------------------------------------------------------------------------

const SYNC_ENCRYPTION_TRANSITION_TMP_SUFFIX: &str = ".enctransition";
const SYNC_ENCRYPTION_STAGE_DIR_PREFIX: &str = ".mindwtr-encryption-stage-";
const SYNC_ENCRYPTION_QUARANTINE_DIR_PREFIX: &str = ".mindwtr-encryption-quarantine-";
const SYNC_ENCRYPTION_MOBILE_SCRATCH_PREFIX: &str = ".mindwtr-et-";
/// Mirrors ATTACHMENTS_DIR_NAME in packages/core/src/attachment-paths.ts.
const SYNC_ATTACHMENTS_DIR_NAME: &str = "attachments";

/// Every artifact in the folder the transition must convert. Retained recovery generations
/// and attachments are converted before non-base documents, then the base document last. A
/// reader that finds `data.json.enc` must never find it referencing a `.bak` or attachment
/// that is not itself already migrated.
struct SyncFolderArtifacts {
    attachments: Vec<SyncDocumentGeneration>,
    documents: Vec<SyncDocumentGeneration>,
    /// Retained generations from an earlier failed/conflicted transition. They keep their
    /// exact path and are transformed in place like attachments; never rename or delete them.
    recovery: Vec<SyncDocumentGeneration>,
}

struct SyncDocumentGeneration {
    path: PathBuf,
    bytes: Vec<u8>,
    version: String,
}

struct ManagedSyncDocumentGenerations {
    sync_dir: PathBuf,
    versions: BTreeMap<String, Option<String>>,
    attachment_versions: BTreeMap<PathBuf, String>,
    recovery_versions: BTreeMap<PathBuf, String>,
}

fn is_transition_recovery_dir(name: &str) -> bool {
    name.starts_with(SYNC_ENCRYPTION_STAGE_DIR_PREFIX)
        || name.starts_with(SYNC_ENCRYPTION_QUARANTINE_DIR_PREFIX)
}

fn is_transition_scratch(name: &str) -> bool {
    // Only names Mindwtr itself reserves for encryption-transition recovery are scratch.
    // Attachment cloud keys preserve a user's original extension, so `.tmp`, `.previous`,
    // `.lock`, and dot-prefixed names are all legitimate attachment generations.
    name.ends_with(SYNC_ENCRYPTION_TRANSITION_TMP_SUFFIX)
        || name.starts_with(SYNC_ENCRYPTION_MOBILE_SCRATCH_PREFIX)
}

fn transition_directory_entries(dir: &Path) -> Result<fs::ReadDir, String> {
    fs::read_dir(dir).map_err(|error| {
        format!(
            "Failed to enumerate sync encryption transition directory {}: {error}",
            dir.display()
        )
    })
}

fn transition_regular_file_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Refusing to follow symbolic link during sync encryption transition: {}",
            path.display()
        )),
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(format!(
            "Sync encryption transition expected a regular file at {}",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Failed to inspect sync encryption transition artifact {}: {error}",
            path.display()
        )),
    }
}

fn collect_sync_folder_attachments(sync_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut found = Vec::new();
    let attachments_dir = sync_dir.join(SYNC_ATTACHMENTS_DIR_NAME);
    match fs::symlink_metadata(&attachments_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(found),
        Err(error) => {
            return Err(format!(
                "Failed to inspect sync attachments directory {}: {error}",
                attachments_dir.display()
            ))
        }
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "Refusing to follow symbolic link during sync encryption transition: {}",
                attachments_dir.display()
            ))
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(format!(
                "Sync encryption transition expected an attachments directory at {}",
                attachments_dir.display()
            ))
        }
        Ok(_) => {}
    }
    let mut stack = vec![attachments_dir];
    while let Some(dir) = stack.pop() {
        for entry in transition_directory_entries(&dir)? {
            let entry = entry.map_err(|error| {
                format!(
                    "Failed to enumerate an entry in sync transition directory {}: {error}",
                    dir.display()
                )
            })?;
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| format!("Sync transition path is not valid UTF-8: {}", path.display()))?;
            let file_type = entry.file_type().map_err(|error| {
                format!("Failed to inspect sync transition artifact {}: {error}", path.display())
            })?;
            if file_type.is_symlink() {
                return Err(format!(
                    "Refusing to follow symbolic link during sync encryption transition: {}",
                    path.display()
                ));
            }
            if file_type.is_dir() {
                // Retained transition directories are snapshotted separately as in-place
                // recovery generations, so they cannot be duplicated in the attachment set.
                if is_transition_recovery_dir(name) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !file_type.is_file() {
                return Err(format!(
                    "Sync encryption transition expected a regular file at {}",
                    path.display()
                ));
            }
            if is_transition_scratch(name) {
                continue;
            }
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

/// Snapshots every file retained by a failed transition before the next transition starts.
/// Nested recovery directories are possible when recovery itself conflicts, so the walk keeps
/// an explicit `inside_recovery` bit and preserves every divergent generation independently.
/// Legacy sibling `.enctransition` files are included as well.
fn collect_transition_recovery_artifacts_with<ReadDir>(
    sync_dir: &Path,
    mut read_dir: ReadDir,
) -> Result<Vec<PathBuf>, String>
where
    ReadDir: FnMut(&Path) -> std::io::Result<fs::ReadDir>,
{
    let mut found = Vec::new();
    let mut stack = vec![(sync_dir.to_path_buf(), false)];
    while let Some((dir, inside_recovery)) = stack.pop() {
        let entries = read_dir(&dir).map_err(|error| {
            format!(
                "Failed to enumerate sync encryption recovery directory {}: {error}",
                dir.display()
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!(
                    "Failed to enumerate an entry in sync recovery directory {}: {error}",
                    dir.display()
                )
            })?;
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| format!("Sync recovery path is not valid UTF-8: {}", path.display()))?;
            let file_type = entry.file_type().map_err(|error| {
                format!("Failed to inspect sync recovery artifact {}: {error}", path.display())
            })?;
            if file_type.is_symlink() {
                return Err(format!(
                    "Refusing to follow symbolic link during sync encryption transition: {}",
                    path.display()
                ));
            }
            if file_type.is_dir() {
                let child_is_recovery = inside_recovery || is_transition_recovery_dir(name);
                stack.push((path, child_is_recovery));
                continue;
            }
            if !file_type.is_file() {
                return Err(format!(
                    "Sync encryption transition expected a regular file at {}",
                    path.display()
                ));
            }
            if inside_recovery
                || name.ends_with(SYNC_ENCRYPTION_TRANSITION_TMP_SUFFIX)
                || name.starts_with(SYNC_ENCRYPTION_MOBILE_SCRATCH_PREFIX)
            {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

fn collect_transition_recovery_artifacts(sync_dir: &Path) -> Result<Vec<PathBuf>, String> {
    collect_transition_recovery_artifacts_with(sync_dir, |path| fs::read_dir(path))
}

/// `encrypting` selects which generation to look for: the plaintext names when enabling, the
/// `.enc` names when disabling. Passphrase rotation reuses the `.enc` side.
fn collect_sync_folder_artifacts(
    sync_dir: &Path,
    encrypting: bool,
) -> Result<SyncFolderArtifacts, String> {
    let base = if encrypting {
        DATA_FILE_NAME.to_string()
    } else {
        encrypted_artifact_name(DATA_FILE_NAME)
    };
    let legacy_plain = format!("{}-sync.json", APP_NAME);
    let legacy = if encrypting { legacy_plain.clone() } else { encrypted_artifact_name(&legacy_plain) };

    let mut documents: Vec<PathBuf> = Vec::new();
    // Non-base first; the base document is pushed last, below.
    for name in [
        format!("{base}.bak"),
        format!("{base}.bak.previous"),
        format!("{base}.previous"),
        legacy,
    ] {
        let path = sync_dir.join(&name);
        if transition_regular_file_exists(&path)? {
            documents.push(path);
        }
    }

    // Seed backups (`mindwtr-backup-*.json` / `data-backup-*.json`), the same set the recovery
    // chain reads. Encrypted ones carry the `.json.enc` tail.
    let seed_suffix = if encrypting { ".json" } else { ".json.enc" };
    let mut seeds: Vec<PathBuf> = Vec::new();
    for entry in transition_directory_entries(sync_dir)? {
        let entry = entry.map_err(|error| {
            format!(
                "Failed to enumerate an entry in sync transition directory {}: {error}",
                sync_dir.display()
            )
        })?;
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("Sync transition path is not valid UTF-8: {}", path.display()))?;
        let lower = name.to_ascii_lowercase();
        if !(lower.starts_with("mindwtr-backup-") || lower.starts_with("data-backup-"))
            || !lower.ends_with(seed_suffix)
        {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| {
            format!("Failed to inspect sync transition artifact {}: {error}", path.display())
        })?;
        if file_type.is_symlink() {
            return Err(format!(
                "Refusing to follow symbolic link during sync encryption transition: {}",
                path.display()
            ));
        }
        if !file_type.is_file() {
            return Err(format!(
                "Sync encryption transition expected a regular file at {}",
                path.display()
            ));
        }
        seeds.push(path);
    }
    seeds.sort();
    documents.append(&mut seeds);

    let base_path = sync_dir.join(&base);
    if transition_regular_file_exists(&base_path)? {
        documents.push(base_path);
    }

    // Bind the attachment worklist to this exact document generation. A peer generation
    // visible before these reads is followed by the fresh attachment enumeration below;
    // one that lands during enumeration invalidates the snapshot before mutation starts.
    let documents = documents
        .into_iter()
        .map(snapshot_sync_document)
        .collect::<Result<Vec<_>, _>>()?;
    let attachments = collect_sync_folder_attachments(sync_dir)?
        .into_iter()
        .map(snapshot_sync_document)
        .collect::<Result<Vec<_>, _>>()?;
    let recovery = collect_transition_recovery_artifacts(sync_dir)?
        .into_iter()
        .map(snapshot_sync_document)
        .collect::<Result<Vec<_>, _>>()?;
    for document in &documents {
        require_sync_document_generation(document)?;
    }

    Ok(SyncFolderArtifacts {
        attachments,
        documents,
        recovery,
    })
}

fn transition_artifact_fingerprint(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
}

fn snapshot_sync_document(path: PathBuf) -> Result<SyncDocumentGeneration, String> {
    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let version = transition_artifact_fingerprint(&bytes);
    Ok(SyncDocumentGeneration {
        path,
        bytes,
        version,
    })
}

fn require_sync_document_generation(document: &SyncDocumentGeneration) -> Result<(), String> {
    if !transition_regular_file_exists(&document.path)? {
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    let current = fs::read(&document.path)
        .map_err(|error| format!("Failed to read {}: {error}", document.path.display()))?;
    if transition_artifact_fingerprint(&current) != document.version {
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    Ok(())
}

fn is_seed_backup_document_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    (lower.starts_with("mindwtr-backup-") || lower.starts_with("data-backup-"))
        && (lower.ends_with(".json") || lower.ends_with(".json.enc"))
}

fn managed_sync_document_names(sync_dir: &Path) -> Result<BTreeSet<String>, String> {
    let legacy = format!("{}-sync.json", APP_NAME);
    let plaintext_names = [
        DATA_FILE_NAME.to_string(),
        format!("{DATA_FILE_NAME}.bak"),
        format!("{DATA_FILE_NAME}.bak.previous"),
        format!("{DATA_FILE_NAME}.previous"),
        legacy,
    ];
    let mut names = BTreeSet::new();
    for name in plaintext_names {
        names.insert(encrypted_artifact_name(&name));
        names.insert(name);
    }
    for entry in transition_directory_entries(sync_dir)? {
        let entry = entry.map_err(|error| {
            format!(
                "Failed to enumerate an entry in sync transition directory {}: {error}",
                sync_dir.display()
            )
        })?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|name| format!("Sync transition path is not valid UTF-8: {name:?}"))?;
        if !is_seed_backup_document_name(&name) {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "Failed to inspect sync transition artifact {}: {error}",
                entry.path().display()
            )
        })?;
        if file_type.is_symlink() {
            return Err(format!(
                "Refusing to follow symbolic link during sync encryption transition: {}",
                entry.path().display()
            ));
        }
        if !file_type.is_file() {
            return Err(format!(
                "Sync encryption transition expected a regular file at {}",
                entry.path().display()
            ));
        }
        if name.to_ascii_lowercase().ends_with(".json.enc") {
            names.insert(plaintext_artifact_name(&name));
        } else {
            names.insert(encrypted_artifact_name(&name));
        }
        names.insert(name);
    }
    Ok(names)
}

fn sync_attachment_relative_path(sync_dir: &Path, path: &Path) -> Result<PathBuf, String> {
    path.strip_prefix(sync_dir)
        .map(Path::to_path_buf)
        .map_err(|_| format!("Sync transition artifact escaped its root: {}", path.display()))
}

fn snapshot_managed_sync_attachment_generations(
    sync_dir: &Path,
) -> Result<BTreeMap<PathBuf, String>, String> {
    let mut versions = BTreeMap::new();
    for path in collect_sync_folder_attachments(sync_dir)? {
        let relative = sync_attachment_relative_path(sync_dir, &path)?;
        let bytes = fs::read(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        versions.insert(relative, transition_artifact_fingerprint(&bytes));
    }
    Ok(versions)
}

fn captured_sync_attachment_generations(
    sync_dir: &Path,
    attachments: &[SyncDocumentGeneration],
) -> Result<BTreeMap<PathBuf, String>, String> {
    attachments
        .iter()
        .map(|attachment| {
            Ok((
                sync_attachment_relative_path(sync_dir, &attachment.path)?,
                attachment.version.clone(),
            ))
        })
        .collect()
}

fn snapshot_managed_sync_recovery_generations(
    sync_dir: &Path,
) -> Result<BTreeMap<PathBuf, String>, String> {
    let mut versions = BTreeMap::new();
    for path in collect_transition_recovery_artifacts(sync_dir)? {
        let relative = sync_attachment_relative_path(sync_dir, &path)?;
        let bytes = fs::read(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        versions.insert(relative, transition_artifact_fingerprint(&bytes));
    }
    Ok(versions)
}

fn captured_sync_recovery_generations(
    sync_dir: &Path,
    recovery: &[SyncDocumentGeneration],
) -> Result<BTreeMap<PathBuf, String>, String> {
    recovery
        .iter()
        .map(|artifact| {
            Ok((
                sync_attachment_relative_path(sync_dir, &artifact.path)?,
                artifact.version.clone(),
            ))
        })
        .collect()
}

fn snapshot_managed_sync_document_generations(
    sync_dir: &Path,
    material: Option<&SyncKeyMaterial>,
    require_encrypted_base: bool,
) -> Result<ManagedSyncDocumentGenerations, String> {
    let encrypted_base = encrypted_artifact_name(DATA_FILE_NAME);
    let mut versions = BTreeMap::new();
    for name in managed_sync_document_names(sync_dir)? {
        let path = sync_dir.join(&name);
        if !transition_regular_file_exists(&path)? {
            versions.insert(name, None);
            continue;
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        if name == encrypted_base {
            if let Some(material) = material {
                let plaintext = decrypt_sync_artifact(&bytes, &material.key)
                    .map_err(|error| terminal_error(error))?;
                serde_json::from_slice::<Value>(&plaintext).map_err(|error| {
                    terminal_error(format!(
                        "Encrypted sync document is not valid JSON: {error}"
                    ))
                })?;
            }
        }
        versions.insert(name, Some(transition_artifact_fingerprint(&bytes)));
    }
    if require_encrypted_base && !matches!(versions.get(&encrypted_base), Some(Some(_))) {
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    Ok(ManagedSyncDocumentGenerations {
        sync_dir: sync_dir.to_path_buf(),
        versions,
        attachment_versions: snapshot_managed_sync_attachment_generations(sync_dir)?,
        recovery_versions: snapshot_managed_sync_recovery_generations(sync_dir)?,
    })
}

fn require_captured_sync_attachment_generations(
    generation: &ManagedSyncDocumentGenerations,
    attachments: &[SyncDocumentGeneration],
) -> Result<(), String> {
    if generation.attachment_versions
        != captured_sync_attachment_generations(&generation.sync_dir, attachments)?
    {
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    Ok(())
}

fn require_captured_sync_recovery_generations(
    generation: &ManagedSyncDocumentGenerations,
    recovery: &[SyncDocumentGeneration],
) -> Result<(), String> {
    if generation.recovery_versions
        != captured_sync_recovery_generations(&generation.sync_dir, recovery)?
    {
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    Ok(())
}

fn require_managed_sync_document_generations(
    generation: &ManagedSyncDocumentGenerations,
) -> Result<(), String> {
    let current = snapshot_managed_sync_document_generations(&generation.sync_dir, None, false)?;
    if current.versions != generation.versions
        || current.attachment_versions != generation.attachment_versions
        || current.recovery_versions != generation.recovery_versions
    {
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    Ok(())
}

fn set_expected_managed_sync_document_generation(
    generation: &mut ManagedSyncDocumentGenerations,
    path: &Path,
    version: Option<String>,
) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Sync transition path is not valid UTF-8: {}", path.display()))?;
    generation.versions.insert(name.to_string(), version);
    Ok(())
}

fn set_expected_managed_sync_attachment_generation(
    generation: &mut ManagedSyncDocumentGenerations,
    path: &Path,
    version: String,
) -> Result<(), String> {
    let relative = sync_attachment_relative_path(&generation.sync_dir, path)?;
    generation.attachment_versions.insert(relative, version);
    Ok(())
}

fn set_expected_managed_sync_recovery_generation(
    generation: &mut ManagedSyncDocumentGenerations,
    path: &Path,
    version: String,
) -> Result<(), String> {
    let relative = sync_attachment_relative_path(&generation.sync_dir, path)?;
    generation.recovery_versions.insert(relative, version);
    Ok(())
}

fn require_no_managed_plaintext_document_generations(
    generation: &ManagedSyncDocumentGenerations,
) -> Result<(), String> {
    if generation.versions.iter().any(|(name, version)| {
        version.is_some() && plaintext_artifact_name(name) == *name
    }) {
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    Ok(())
}

fn validate_expected_encrypted_base(
    generation: &ManagedSyncDocumentGenerations,
    material: &SyncKeyMaterial,
) -> Result<(), String> {
    let name = encrypted_artifact_name(DATA_FILE_NAME);
    let Some(Some(expected)) = generation.versions.get(&name) else {
        return Ok(());
    };
    let path = generation.sync_dir.join(name);
    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    if transition_artifact_fingerprint(&bytes) != *expected {
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    let plaintext =
        decrypt_sync_artifact(&bytes, &material.key).map_err(|error| terminal_error(error))?;
    serde_json::from_slice::<Value>(&plaintext).map_err(|error| {
        terminal_error(format!(
            "Encrypted sync document is not valid JSON: {error}"
        ))
    })?;
    Ok(())
}

fn finalize_enabled_file_generation_with<BeforeRevalidate, Persist>(
    generation: &ManagedSyncDocumentGenerations,
    material: &SyncKeyMaterial,
    before_revalidate: BeforeRevalidate,
    persist: Persist,
) -> Result<(), String>
where
    BeforeRevalidate: FnOnce() -> Result<(), String>,
    Persist: FnOnce(&SyncKeyMaterial) -> Result<(), String>,
{
    before_revalidate()?;
    require_managed_sync_document_generations(generation)?;
    validate_expected_encrypted_base(generation, material)?;
    persist(material)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TransitionMutationPoint {
    BeforeQuarantine,
    BeforeInstall,
    BeforeRemoveCommit,
}

struct TransitionScratch {
    directory: PathBuf,
    path: PathBuf,
}

#[cfg(windows)]
fn transition_path_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn move_transition_path_durably(source: &Path, destination: &Path) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source = transition_path_wide(source);
    let destination = transition_path_wide(destination);
    // SAFETY: both path buffers are NUL-terminated and remain alive for the call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn move_transition_path_durably(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_transition_path_durably(source: &Path, destination: &Path) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = transition_path_wide(source);
    let destination = transition_path_wide(destination);
    // SAFETY: both path buffers are NUL-terminated and remain alive for the call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(all(not(windows), test))]
fn replace_transition_path_durably(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn finish_transition_move_durably_with<Move, SyncParent>(
    source: &Path,
    destination: &Path,
    move_path: Move,
    mut sync_parent: SyncParent,
) -> Result<(), String>
where
    Move: FnOnce(&Path, &Path) -> Result<(), String>,
    SyncParent: FnMut(&Path) -> std::io::Result<()>,
{
    move_path(source, destination)?;
    sync_parent(source).map_err(|error| {
        format!("Failed to flush transition source directory metadata: {error}")
    })?;
    sync_parent(destination).map_err(|error| {
        format!("Failed to flush transition destination directory metadata: {error}")
    })
}

fn create_transition_scratch(
    target: &Path,
    label: &str,
    bytes: Option<&[u8]>,
) -> Result<TransitionScratch, String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", target.display()))?;
    let leaf = target
        .file_name()
        .ok_or_else(|| format!("{} has no file name", target.display()))?;
    for _ in 0..32 {
        let nonce = rand::thread_rng().next_u64();
        let directory = parent.join(format!(".mindwtr-{label}-{nonce:016x}"));
        match fs::create_dir(&directory) {
            Ok(()) => {
                sync_parent_directory_for_durability(&directory).map_err(|error| {
                    format!("Failed to flush transition scratch parent directory: {error}")
                })?;
                let path = directory.join(leaf);
                if let Some(payload) = bytes {
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&path)
                        .map_err(|error| {
                            format!(
                                "Failed to create transition scratch {}: {error}",
                                path.display()
                            )
                        })?;
                    file.write_all(payload).map_err(|error| {
                        format!(
                            "Failed to write transition scratch {}: {error}",
                            path.display()
                        )
                    })?;
                    file.sync_all().map_err(|error| {
                        format!(
                            "Failed to flush transition scratch {}: {error}",
                            path.display()
                        )
                    })?;
                }
                sync_parent_directory_for_durability(&path).map_err(|error| {
                    format!("Failed to flush transition scratch directory: {error}")
                })?;
                return Ok(TransitionScratch { directory, path });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create transition scratch directory: {error}"
                ))
            }
        }
    }
    Err("Failed to allocate a unique transition scratch directory".to_string())
}

fn copy_file_create_new(source: &Path, target: &Path) -> Result<(), String> {
    let mut input = File::open(source).map_err(|error| {
        format!(
            "Failed to open transition source {}: {error}",
            source.display()
        )
    })?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                SYNC_FILE_WRITE_CONFLICT.to_string()
            } else {
                format!(
                    "Failed to create transition target {}: {error}",
                    target.display()
                )
            }
        })?;
    std::io::copy(&mut input, &mut output).map_err(|error| {
        format!(
            "Failed to copy transition target {}: {error}",
            target.display()
        )
    })?;
    output.sync_all().map_err(|error| {
        format!(
            "Failed to flush transition target {}: {error}",
            target.display()
        )
    })?;
    sync_parent_directory_for_durability(target)
        .map_err(|error| format!("Failed to flush sync directory metadata: {error}"))
}

fn restore_quarantined_generation(quarantine: &TransitionScratch, target: &Path) {
    // Conflict recovery is deliberately best-effort and non-destructive: create_new cannot
    // overwrite a peer that already restored/created the canonical name, and the exact bytes
    // atomically displaced into quarantine remain there if restoration is not possible.
    let _ = copy_file_create_new(&quarantine.path, target);
}

fn quarantine_transition_artifact<Hook>(
    target: &Path,
    hook: &mut Hook,
) -> Result<TransitionScratch, String>
where
    Hook: FnMut(TransitionMutationPoint, &Path) -> Result<(), String>,
{
    let quarantine = create_transition_scratch(target, "encryption-quarantine", None)?;
    hook(TransitionMutationPoint::BeforeQuarantine, target)?;
    finish_transition_move_durably_with(
        target,
        &quarantine.path,
        |source, destination| {
            move_transition_path_durably(source, destination).map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    SYNC_FILE_WRITE_CONFLICT.to_string()
                } else {
                    format!("Failed to quarantine {}: {error}", target.display())
                }
            })
        },
        sync_parent_directory_for_durability,
    )?;
    Ok(quarantine)
}

#[cfg(any(windows, test))]
fn replace_transition_scratch_with_safe_generation_with<WriteNew, Replace>(
    scratch: &TransitionScratch,
    replacement: Option<&Path>,
    mut write_new: WriteNew,
    replace: Replace,
) -> Result<(), String>
where
    WriteNew: FnMut(&Path, &[u8]) -> std::io::Result<()>,
    Replace: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    let Some(replacement) = replacement else {
        return Ok(());
    };
    let bytes = fs::read(replacement).map_err(|error| {
        format!(
            "Failed to read verified transition replacement {}: {error}",
            replacement.display()
        )
    })?;

    let mut safe_path = None;
    for _ in 0..32 {
        let candidate = scratch.directory.join(format!(
            ".mindwtr-encryption-safe-{:016x}",
            rand::thread_rng().next_u64(),
        ));
        match write_new(&candidate, &bytes) {
            Ok(()) => {
                safe_path = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create safe transition recovery generation: {error}"
                ))
            }
        }
    }
    let safe_path = safe_path.ok_or_else(|| {
        "Failed to allocate a unique safe transition recovery generation".to_string()
    })?;
    // `scratch.path` is a uniquely owned, fingerprint-verified quarantine. Replacing it is safe;
    // reopening it with O_TRUNC is not (cache-off rclone/WinFSP refuses existing-file size
    // changes). If the move fails, retain both the original and the flushed safe sibling.
    replace(&safe_path, &scratch.path).map_err(|error| {
        format!(
            "Failed to install safe transition recovery generation {}: {error}",
            scratch.path.display()
        )
    })
}

#[cfg(windows)]
fn replace_transition_scratch_with_safe_generation(
    scratch: &TransitionScratch,
    replacement: Option<&Path>,
) -> Result<(), String> {
    replace_transition_scratch_with_safe_generation_with(
        scratch,
        replacement,
        |path, bytes| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?;
            file.write_all(bytes)?;
            file.sync_all()
        },
        replace_transition_path_durably,
    )
}

#[cfg(not(windows))]
fn replace_transition_scratch_with_safe_generation(
    _scratch: &TransitionScratch,
    _replacement: Option<&Path>,
) -> Result<(), String> {
    Ok(())
}

fn finish_transition_scratch_cleanup_durably_with<RemoveFile, RemoveDir, SyncParent>(
    scratch: &TransitionScratch,
    file_exists: bool,
    mut remove_file: RemoveFile,
    remove_dir: RemoveDir,
    mut sync_parent: SyncParent,
) -> Result<(), String>
where
    RemoveFile: FnMut(&Path) -> std::io::Result<()>,
    RemoveDir: FnOnce(&Path) -> std::io::Result<()>,
    SyncParent: FnMut(&Path) -> std::io::Result<()>,
{
    if file_exists {
        remove_file(&scratch.path).map_err(|error| {
            format!(
                "Failed to remove transition scratch {}: {error}",
                scratch.path.display()
            )
        })?;
    }
    // Flush even when the file was already absent: a retry must durably acknowledge the
    // earlier deletion before the containing recovery directory can disappear.
    sync_parent(&scratch.path).map_err(|error| {
        format!("Failed to flush transition recovery directory metadata: {error}")
    })?;
    remove_dir(&scratch.directory).map_err(|error| {
        format!(
            "Failed to remove transition scratch directory {}: {error}",
            scratch.directory.display()
        )
    })?;
    sync_parent(&scratch.directory)
        .map_err(|error| format!("Failed to flush transition cleanup metadata: {error}"))
}

fn cleanup_transition_scratch(
    scratch: TransitionScratch,
    durable_replacement: Option<&Path>,
) -> Result<(), String> {
    // On Windows, MOVEFILE_WRITE_THROUGH makes the recovery-name displacement durable. A
    // verified current-posture generation is copied over quarantine bytes first, so even if
    // the subsequent delete is resurrected by a filesystem that cannot flush directories,
    // no plaintext or obsolete-key generation can reappear after state commit.
    replace_transition_scratch_with_safe_generation(&scratch, durable_replacement)?;
    let cleanup_directory = scratch.directory.with_extension("cleanup");
    let leaf = scratch
        .path
        .file_name()
        .ok_or_else(|| format!("Transition scratch has no file name: {}", scratch.path.display()))?;
    finish_transition_move_durably_with(
        &scratch.directory,
        &cleanup_directory,
        |source, destination| {
            move_transition_path_durably(source, destination).map_err(|error| {
                format!("Failed to prepare transition scratch cleanup: {error}")
            })
        },
        sync_parent_directory_for_durability,
    )?;
    let cleanup = TransitionScratch {
        path: cleanup_directory.join(leaf),
        directory: cleanup_directory,
    };
    finish_transition_scratch_cleanup_durably_with(
        &cleanup,
        cleanup.path.exists(),
        |path| fs::remove_file(path),
        |path| fs::remove_dir(path),
        sync_parent_directory_for_durability,
    )
}

fn require_quarantined_generation(
    quarantine: &TransitionScratch,
    expected: &str,
    target: &Path,
) -> Result<(), String> {
    let current = fs::read(&quarantine.path).map_err(|error| {
        format!(
            "Failed to revalidate quarantined {}: {error}",
            target.display()
        )
    })?;
    if transition_artifact_fingerprint(&current) != expected {
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    Ok(())
}

fn remove_transition_artifact_if_version_with_hook<Hook>(
    path: &Path,
    expected: &str,
    durable_replacement: &Path,
    mut hook: Hook,
) -> Result<(), String>
where
    Hook: FnMut(TransitionMutationPoint, &Path) -> Result<(), String>,
{
    let quarantine = quarantine_transition_artifact(path, &mut hook)?;
    let displaced = fs::read(&quarantine.path)
        .map_err(|error| format!("Failed to inspect quarantined {}: {error}", path.display()))?;
    if transition_artifact_fingerprint(&displaced) != expected {
        restore_quarantined_generation(&quarantine, path);
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    hook(TransitionMutationPoint::BeforeRemoveCommit, path)?;
    if path.exists() {
        // A peer created a new canonical generation after quarantine. Keep both it and the
        // exact displaced generation; never call remove_file on either one.
        return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
    }
    require_quarantined_generation(&quarantine, expected, path)?;
    cleanup_transition_scratch(quarantine, Some(durable_replacement))?;
    sync_parent_directory_for_durability(path)
        .map_err(|error| format!("Failed to flush sync directory metadata: {error}"))
}

fn remove_transition_artifact_if_version(
    path: &Path,
    expected: &str,
    durable_replacement: &Path,
) -> Result<(), String> {
    remove_transition_artifact_if_version_with_hook(
        path,
        expected,
        durable_replacement,
        |_, _| Ok(()),
    )
}

/// An artifact whose MWENC1 header is present but unreadable (truncated, a future format
/// version, a cost above the accepted ceiling) is neither plaintext to seal nor ciphertext we
/// can open. Every transition raises this instead of guessing: sealing it would double-wrap a
/// container nothing can recover, and skipping it would silently leave it behind. Mirrors
/// core's `unsupportedArtifact`.
fn unsupported_artifact(path: &Path, reason: String) -> String {
    terminal_error(format!("{}: {reason}", path.display()))
}

/// Writes `bytes` at `target` through a scratch file, then reads it back and runs `verify`
/// before returning. Nothing downstream may delete a predecessor until this has succeeded.
fn write_and_verify<Verify>(
    target: &Path,
    bytes: &[u8],
    expected_version: Option<&str>,
    verify: Verify,
) -> Result<(), String>
where
    Verify: Fn(&[u8]) -> Result<(), String>,
{
    write_and_verify_with_hook(target, bytes, expected_version, verify, |_, _| Ok(()))
}

fn write_and_verify_with_hook<Verify, Hook>(
    target: &Path,
    bytes: &[u8],
    expected_version: Option<&str>,
    verify: Verify,
    mut hook: Hook,
) -> Result<(), String>
where
    Verify: Fn(&[u8]) -> Result<(), String>,
    Hook: FnMut(TransitionMutationPoint, &Path) -> Result<(), String>,
{
    let staged = create_transition_scratch(target, "encryption-stage", Some(bytes))?;
    let quarantined = if let Some(expected) = expected_version {
        let quarantine = quarantine_transition_artifact(target, &mut hook)?;
        let displaced = fs::read(&quarantine.path).map_err(|error| {
            format!(
                "Failed to inspect quarantined {}: {error}",
                target.display()
            )
        })?;
        if transition_artifact_fingerprint(&displaced) != expected {
            restore_quarantined_generation(&quarantine, target);
            return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
        }
        Some((quarantine, expected))
    } else {
        None
    };
    hook(TransitionMutationPoint::BeforeInstall, target)?;
    copy_file_create_new(&staged.path, target)?;
    let written = fs::read(target)
        .map_err(|error| format!("Failed to read back {}: {error}", target.display()))?;
    verify(&written)?;
    if let Some((quarantine, expected)) = quarantined {
        require_quarantined_generation(&quarantine, expected, target)?;
        cleanup_transition_scratch(quarantine, Some(target))?;
    }
    cleanup_transition_scratch(staged, None)
}

fn seal_artifact_generation_in_place(
    artifact: &SyncDocumentGeneration,
    material: &SyncKeyMaterial,
) -> Result<String, String> {
    require_sync_document_generation(artifact)?;
    match inspect_sync_artifact(&artifact.bytes) {
        SyncArtifactInspection::Encrypted(_) => return Ok(artifact.version.clone()),
        SyncArtifactInspection::Unsupported(reason) => {
            return Err(unsupported_artifact(&artifact.path, reason))
        }
        SyncArtifactInspection::Plaintext => {}
    }
    let sealed = encrypt_sync_artifact(&artifact.bytes, material)
        .map_err(|error| terminal_error(error))?;
    write_and_verify(&artifact.path, &sealed, Some(&artifact.version), |written| {
        let plain = decrypt_sync_artifact(written, &material.key).map_err(|error| terminal_error(error))?;
        if plain == artifact.bytes {
            Ok(())
        } else {
            Err(SYNC_FILE_WRITE_CONFLICT.to_string())
        }
    })?;
    Ok(transition_artifact_fingerprint(&sealed))
}

fn authenticate_artifact_with_passphrase(
    path: &Path,
    bytes: &[u8],
    passphrase: &str,
    recovered_by_salt: &mut HashMap<[u8; SALT_LEN], SyncKeyMaterial>,
) -> Result<Option<SyncKeyMaterial>, String> {
    let header = match inspect_sync_artifact(bytes) {
        SyncArtifactInspection::Plaintext => return Ok(None),
        SyncArtifactInspection::Unsupported(reason) => {
            return Err(unsupported_artifact(path, reason))
        }
        SyncArtifactInspection::Encrypted(header) => header,
    };
    let material = if let Some(material) = recovered_by_salt.get(&header.salt) {
        material.clone()
    } else {
        let material = derive_sync_key_material(passphrase, header.salt, header.params)
            .map_err(|error| terminal_error(error))?;
        recovered_by_salt.insert(header.salt, material.clone());
        material
    };
    decrypt_sync_artifact(bytes, &material.key).map_err(|error| terminal_error(error))?;
    Ok(Some(material))
}

fn authenticate_encrypted_named_document(
    document: &SyncDocumentGeneration,
    passphrase: &str,
    recovered_by_salt: &mut HashMap<[u8; SALT_LEN], SyncKeyMaterial>,
) -> Result<SyncKeyMaterial, String> {
    authenticate_artifact_with_passphrase(
        &document.path,
        &document.bytes,
        passphrase,
        recovered_by_salt,
    )?
    .ok_or_else(|| {
        terminal_error(format!(
            "{} is not a valid MWENC1 container",
            document.path.display()
        ))
    })
}

fn preflight_artifact_for_rotation(
    path: &Path,
    bytes: &[u8],
    old_key: &[u8; KEY_LEN],
    next_passphrase: &str,
    recovered_by_salt: &mut HashMap<[u8; SALT_LEN], SyncKeyMaterial>,
    encrypted_name: bool,
) -> Result<(), String> {
    match inspect_sync_artifact(bytes) {
        SyncArtifactInspection::Plaintext if !encrypted_name => Ok(()),
        SyncArtifactInspection::Plaintext => Err(terminal_error(format!(
            "{} is not a valid MWENC1 container",
            path.display()
        ))),
        SyncArtifactInspection::Unsupported(reason) => Err(unsupported_artifact(path, reason)),
        SyncArtifactInspection::Encrypted(header) => {
            if decrypt_sync_artifact(bytes, old_key).is_ok() {
                return Ok(());
            }
            let recovered = if let Some(material) = recovered_by_salt.get(&header.salt) {
                material.clone()
            } else {
                let material =
                    derive_sync_key_material(next_passphrase, header.salt, header.params)
                        .map_err(|error| terminal_error(error))?;
                recovered_by_salt.insert(header.salt, material.clone());
                material
            };
            decrypt_sync_artifact(bytes, &recovered.key)
                .map(|_| ())
                .map_err(|error| terminal_error(error))
        }
    }
}

fn preflight_artifact_for_disable(
    path: &Path,
    bytes: &[u8],
    key: &[u8; KEY_LEN],
    encrypted_name: bool,
) -> Result<(), String> {
    match inspect_sync_artifact(bytes) {
        SyncArtifactInspection::Plaintext if !encrypted_name => Ok(()),
        SyncArtifactInspection::Plaintext => Err(terminal_error(format!(
            "{} is not a valid MWENC1 container",
            path.display()
        ))),
        SyncArtifactInspection::Unsupported(reason) => Err(unsupported_artifact(path, reason)),
        SyncArtifactInspection::Encrypted(_) => decrypt_sync_artifact(bytes, key)
            .map(|_| ())
            .map_err(|error| terminal_error(error)),
    }
}

fn open_artifact_generation_in_place(
    artifact: &SyncDocumentGeneration,
    key: &[u8; KEY_LEN],
) -> Result<String, String> {
    require_sync_document_generation(artifact)?;
    match inspect_sync_artifact(&artifact.bytes) {
        SyncArtifactInspection::Plaintext => return Ok(artifact.version.clone()),
        SyncArtifactInspection::Unsupported(reason) => {
            return Err(unsupported_artifact(&artifact.path, reason))
        }
        SyncArtifactInspection::Encrypted(_) => {}
    }
    let plain = decrypt_sync_artifact(&artifact.bytes, key).map_err(|error| terminal_error(error))?;
    write_and_verify(&artifact.path, &plain, Some(&artifact.version), |written| {
        if written == plain {
            Ok(())
        } else {
            Err(format!("Failed to verify {} after write", artifact.path.display()))
        }
    })?;
    Ok(transition_artifact_fingerprint(&plain))
}

fn rewrap_artifact_generation_in_place(
    path: &Path,
    bytes: &[u8],
    version: &str,
    old_key: &[u8; KEY_LEN],
    next: &SyncKeyMaterial,
    next_passphrase: &str,
    recovered_by_salt: &mut HashMap<[u8; SALT_LEN], SyncKeyMaterial>,
) -> Result<String, String> {
    if decrypt_sync_artifact(&bytes, &next.key).is_ok() {
        return Ok(version.to_string()); // already migrated under the new key (resume)
    }
    let plain = if let Ok(plain) = decrypt_sync_artifact(&bytes, old_key) {
        plain
    } else {
        let header = match inspect_sync_artifact(&bytes) {
            SyncArtifactInspection::Encrypted(header) => header,
            _ => return Err(terminal_error(format!("{} is not a valid MWENC1 container", path.display()))),
        };
        let recovered = if let Some(material) = recovered_by_salt.get(&header.salt) {
            material.clone()
        } else {
            let material = derive_sync_key_material(next_passphrase, header.salt, header.params)
                .map_err(|error| terminal_error(error))?;
            recovered_by_salt.insert(header.salt, material.clone());
            material
        };
        decrypt_sync_artifact(&bytes, &recovered.key).map_err(|error| terminal_error(error))?
    };
    let sealed = encrypt_sync_artifact(&plain, next).map_err(|error| terminal_error(error))?;
    write_and_verify(path, &sealed, Some(version), |written| {
        let verified = decrypt_sync_artifact(written, &next.key).map_err(|error| terminal_error(error))?;
        if verified == plain {
            Ok(())
        } else {
            Err(SYNC_FILE_WRITE_CONFLICT.to_string())
        }
    })?;
    Ok(transition_artifact_fingerprint(&sealed))
}

fn converge_enable_artifact_generation_in_place(
    artifact: &SyncDocumentGeneration,
    material: &SyncKeyMaterial,
    passphrase: &str,
    recovered_by_salt: &mut HashMap<[u8; SALT_LEN], SyncKeyMaterial>,
) -> Result<String, String> {
    require_sync_document_generation(artifact)?;
    match inspect_sync_artifact(&artifact.bytes) {
        SyncArtifactInspection::Plaintext => seal_artifact_generation_in_place(artifact, material),
        SyncArtifactInspection::Unsupported(reason) => {
            Err(unsupported_artifact(&artifact.path, reason))
        }
        SyncArtifactInspection::Encrypted(_) => rewrap_artifact_generation_in_place(
            &artifact.path,
            &artifact.bytes,
            &artifact.version,
            &material.key,
            material,
            passphrase,
            recovered_by_salt,
        ),
    }
}

fn converge_rotation_artifact_generation_in_place(
    artifact: &SyncDocumentGeneration,
    old_key: &[u8; KEY_LEN],
    next: &SyncKeyMaterial,
    next_passphrase: &str,
    recovered_by_salt: &mut HashMap<[u8; SALT_LEN], SyncKeyMaterial>,
) -> Result<String, String> {
    require_sync_document_generation(artifact)?;
    match inspect_sync_artifact(&artifact.bytes) {
        SyncArtifactInspection::Plaintext => seal_artifact_generation_in_place(artifact, next),
        SyncArtifactInspection::Unsupported(reason) => {
            Err(unsupported_artifact(&artifact.path, reason))
        }
        SyncArtifactInspection::Encrypted(_) => rewrap_artifact_generation_in_place(
            &artifact.path,
            &artifact.bytes,
            &artifact.version,
            old_key,
            next,
            next_passphrase,
            recovered_by_salt,
        ),
    }
}

struct EnableTransitionPreflight {
    plaintext_artifacts: SyncFolderArtifacts,
    encrypted_documents: Vec<SyncDocumentGeneration>,
    material: SyncKeyMaterial,
    recovered_by_salt: HashMap<[u8; SALT_LEN], SyncKeyMaterial>,
}

fn preflight_enable_transition(
    sync_dir: &Path,
    passphrase: &str,
) -> Result<EnableTransitionPreflight, String> {
    let plaintext_artifacts = collect_sync_folder_artifacts(sync_dir, true)?;
    let encrypted_artifacts = collect_sync_folder_artifacts(sync_dir, false)?;
    let mut recovered_by_salt = HashMap::new();
    let mut selected = None;

    // collect_sync_folder_artifacts orders the base document last, so reverse traversal makes
    // data.json.enc authoritative when it exists. Every remaining generation is still opened
    // read-only before the journal can start.
    for document in encrypted_artifacts.documents.iter().rev() {
        let material = authenticate_encrypted_named_document(
            document,
            passphrase,
            &mut recovered_by_salt,
        )?;
        if selected.is_none() {
            selected = Some(material);
        }
    }
    for document in &plaintext_artifacts.documents {
        if let Some(material) = authenticate_artifact_with_passphrase(
            &document.path,
            &document.bytes,
            passphrase,
            &mut recovered_by_salt,
        )? {
            if selected.is_none() {
                selected = Some(material);
            }
        }
    }
    for artifact in &plaintext_artifacts.attachments {
        if let Some(material) = authenticate_artifact_with_passphrase(
            &artifact.path,
            &artifact.bytes,
            passphrase,
            &mut recovered_by_salt,
        )? {
            if selected.is_none() {
                selected = Some(material);
            }
        }
    }
    for artifact in &plaintext_artifacts.recovery {
        if let Some(material) = authenticate_artifact_with_passphrase(
            &artifact.path,
            &artifact.bytes,
            passphrase,
            &mut recovered_by_salt,
        )? {
            if selected.is_none() {
                selected = Some(material);
            }
        }
    }

    let material = match selected {
        Some(material) => material,
        None => derive_sync_key_material(
            passphrase,
            random_salt(),
            SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
        )
        .map_err(|error| terminal_error(error))?,
    };
    Ok(EnableTransitionPreflight {
        plaintext_artifacts,
        encrypted_documents: encrypted_artifacts.documents,
        material,
        recovered_by_salt,
    })
}

#[cfg(test)]
fn enable_sync_encryption_in_dir(
    sync_dir: &Path,
    passphrase: &str,
) -> Result<SyncKeyMaterial, String> {
    enable_sync_encryption_in_dir_with(
        sync_dir,
        passphrase,
        || Ok(()),
        |_lock, material, generation| {
            finalize_enabled_file_generation_with(
                generation,
                material,
                || Ok(()),
                |_| Ok(()),
            )
        },
    )
}

fn enable_sync_encryption_in_dir_with<BeforeMutation, Finalize>(
    sync_dir: &Path,
    passphrase: &str,
    before_mutation: BeforeMutation,
    finalize: Finalize,
) -> Result<SyncKeyMaterial, String>
where
    BeforeMutation: FnOnce() -> Result<(), String>,
    Finalize: FnOnce(
        &SyncFileLock,
        &SyncKeyMaterial,
        &ManagedSyncDocumentGenerations,
    ) -> Result<(), String>,
{
    let lock = acquire_sync_lock(sync_dir)?;
    let result = (|| -> Result<SyncKeyMaterial, String> {
        let EnableTransitionPreflight {
            plaintext_artifacts: artifacts,
            encrypted_documents,
            material,
            mut recovered_by_salt,
        } = preflight_enable_transition(sync_dir, passphrase)?;
        let mut generation =
            snapshot_managed_sync_document_generations(sync_dir, None, false)?;
        require_captured_sync_attachment_generations(&generation, &artifacts.attachments)?;
        require_captured_sync_recovery_generations(&generation, &artifacts.recovery)?;
        before_mutation()?;
        // The collection is a fixed pre-transition snapshot. Scratch created by the writes
        // below is therefore never recursively added, while every retained generation from
        // an earlier attempt must be sealed before enabled state can be committed.
        for artifact in &artifacts.recovery {
            let version = converge_enable_artifact_generation_in_place(
                artifact,
                &material,
                passphrase,
                &mut recovered_by_salt,
            )?;
            set_expected_managed_sync_recovery_generation(
                &mut generation,
                &artifact.path,
                version,
            )?;
        }
        for attachment in &artifacts.attachments {
            let version = converge_enable_artifact_generation_in_place(
                attachment,
                &material,
                passphrase,
                &mut recovered_by_salt,
            )?;
            set_expected_managed_sync_attachment_generation(
                &mut generation,
                &attachment.path,
                version,
            )?;
        }
        for document in &encrypted_documents {
            require_sync_document_generation(document)?;
            let version = rewrap_artifact_generation_in_place(
                &document.path,
                &document.bytes,
                &document.version,
                &material.key,
                &material,
                passphrase,
                &mut recovered_by_salt,
            )?;
            set_expected_managed_sync_document_generation(
                &mut generation,
                &document.path,
                Some(version),
            )?;
        }
        for document in &artifacts.documents {
            require_sync_document_generation(document)?;
            let path = &document.path;
            let bytes = &document.bytes;
            match inspect_sync_artifact(&bytes) {
                SyncArtifactInspection::Encrypted(_) => {
                    require_sync_document_generation(document)?;
                    continue;
                }
                SyncArtifactInspection::Unsupported(reason) => {
                    return Err(unsupported_artifact(path, reason))
                }
                SyncArtifactInspection::Plaintext => {}
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let target = sync_dir.join(encrypted_artifact_name(name));
            let sealed =
                encrypt_sync_artifact(&bytes, &material).map_err(|error| terminal_error(error))?;
            let target_version = if transition_regular_file_exists(&target)? {
                let existing = fs::read(&target)
                    .map_err(|error| format!("Failed to read {}: {error}", target.display()))?;
                let plain = decrypt_sync_artifact(&existing, &material.key)
                    .map_err(|error| terminal_error(error))?;
                if plain != *bytes {
                    return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
                }
                transition_artifact_fingerprint(&existing)
            } else {
                write_and_verify(&target, &sealed, None, |written| {
                    let plain = decrypt_sync_artifact(written, &material.key)
                        .map_err(|error| terminal_error(error))?;
                    if plain == *bytes {
                        Ok(())
                    } else {
                        Err(SYNC_FILE_WRITE_CONFLICT.to_string())
                    }
                })?;
                transition_artifact_fingerprint(&sealed)
            };
            // Only now, with the ciphertext on disk and proven readable, does the plaintext go.
            remove_transition_artifact_if_version(path, &document.version, &target)?;
            set_expected_managed_sync_document_generation(
                &mut generation,
                &target,
                Some(target_version),
            )?;
            set_expected_managed_sync_document_generation(&mut generation, path, None)?;
        }
        require_no_managed_plaintext_document_generations(&generation)?;
        revalidate_sync_lock(&lock, sync_dir)?;
        finalize(&lock, &material, &generation)?;
        Ok(material)
    })();
    release_sync_lock(&lock);
    result
}

#[cfg(test)]
fn disable_sync_encryption_in_dir(sync_dir: &Path, key: &[u8; KEY_LEN]) -> Result<(), String> {
    disable_sync_encryption_in_dir_with(
        sync_dir,
        key,
        || Ok(()),
        |_lock, generation| require_managed_sync_document_generations(generation),
    )
}

fn disable_sync_encryption_in_dir_with<BeforeMutation, Finalize>(
    sync_dir: &Path,
    key: &[u8; KEY_LEN],
    before_mutation: BeforeMutation,
    finalize: Finalize,
) -> Result<(), String>
where
    BeforeMutation: FnOnce() -> Result<(), String>,
    Finalize: FnOnce(&SyncFileLock, &ManagedSyncDocumentGenerations) -> Result<(), String>,
{
    let lock = acquire_sync_lock(sync_dir)?;
    let result = (|| -> Result<(), String> {
        let artifacts = collect_sync_folder_artifacts(sync_dir, false)?;
        for document in &artifacts.documents {
            preflight_artifact_for_disable(&document.path, &document.bytes, key, true)?;
        }
        for attachment in &artifacts.attachments {
            preflight_artifact_for_disable(
                &attachment.path,
                &attachment.bytes,
                key,
                false,
            )?;
        }
        for artifact in &artifacts.recovery {
            preflight_artifact_for_disable(&artifact.path, &artifact.bytes, key, false)?;
        }
        let mut generation =
            snapshot_managed_sync_document_generations(sync_dir, None, false)?;
        require_captured_sync_attachment_generations(&generation, &artifacts.attachments)?;
        require_captured_sync_recovery_generations(&generation, &artifacts.recovery)?;
        before_mutation()?;
        for artifact in &artifacts.recovery {
            let version = open_artifact_generation_in_place(artifact, key)?;
            set_expected_managed_sync_recovery_generation(
                &mut generation,
                &artifact.path,
                version,
            )?;
        }
        for attachment in &artifacts.attachments {
            let version = open_artifact_generation_in_place(attachment, key)?;
            set_expected_managed_sync_attachment_generation(
                &mut generation,
                &attachment.path,
                version,
            )?;
        }
        for document in &artifacts.documents {
            require_sync_document_generation(document)?;
            let path = &document.path;
            let bytes = &document.bytes;
            match inspect_sync_artifact(&bytes) {
                SyncArtifactInspection::Plaintext => {
                    require_sync_document_generation(document)?;
                    continue;
                }
                SyncArtifactInspection::Unsupported(reason) => {
                    return Err(unsupported_artifact(path, reason))
                }
                SyncArtifactInspection::Encrypted(_) => {}
            }
            let plain = decrypt_sync_artifact(&bytes, key).map_err(|error| terminal_error(error))?;
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let target = sync_dir.join(plaintext_artifact_name(name));
            let target_version = if transition_regular_file_exists(&target)? {
                let existing = fs::read(&target)
                    .map_err(|error| format!("Failed to read {}: {error}", target.display()))?;
                if existing != plain {
                    return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
                }
                transition_artifact_fingerprint(&existing)
            } else {
                write_and_verify(&target, &plain, None, |written| {
                    if written == plain {
                        Ok(())
                    } else {
                        Err(format!("Failed to verify {} after write", target.display()))
                    }
                })?;
                transition_artifact_fingerprint(&plain)
            };
            remove_transition_artifact_if_version(path, &document.version, &target)?;
            set_expected_managed_sync_document_generation(
                &mut generation,
                &target,
                Some(target_version),
            )?;
            set_expected_managed_sync_document_generation(&mut generation, path, None)?;
        }
        revalidate_sync_lock(&lock, sync_dir)?;
        finalize(&lock, &generation)?;
        Ok(())
    })();
    release_sync_lock(&lock);
    result
}

#[cfg(test)]
fn change_sync_encryption_passphrase_in_dir(
    sync_dir: &Path,
    old_key: &[u8; KEY_LEN],
    next_passphrase: &str,
) -> Result<SyncKeyMaterial, String> {
    change_sync_encryption_passphrase_in_dir_with(
        sync_dir,
        old_key,
        next_passphrase,
        || Ok(()),
        |_lock, material, generation| {
            finalize_enabled_file_generation_with(
                generation,
                material,
                || Ok(()),
                |_| Ok(()),
            )
        },
    )
}

fn change_sync_encryption_passphrase_in_dir_with<BeforeMutation, Finalize>(
    sync_dir: &Path,
    old_key: &[u8; KEY_LEN],
    next_passphrase: &str,
    before_mutation: BeforeMutation,
    finalize: Finalize,
) -> Result<SyncKeyMaterial, String>
where
    BeforeMutation: FnOnce() -> Result<(), String>,
    Finalize: FnOnce(
        &SyncFileLock,
        &SyncKeyMaterial,
        &ManagedSyncDocumentGenerations,
    ) -> Result<(), String>,
{
    let next = derive_sync_key_material(next_passphrase, random_salt(), SYNC_CRYPTO_DEFAULT_KDF_PARAMS)
        .map_err(|error| terminal_error(error))?;
    let lock = acquire_sync_lock(sync_dir)?;
    let result = (|| -> Result<(), String> {
        let artifacts = collect_sync_folder_artifacts(sync_dir, false)?;
        let mut recovered_by_salt: HashMap<[u8; SALT_LEN], SyncKeyMaterial> = HashMap::new();
        for document in &artifacts.documents {
            preflight_artifact_for_rotation(
                &document.path,
                &document.bytes,
                old_key,
                next_passphrase,
                &mut recovered_by_salt,
                true,
            )?;
        }
        for attachment in &artifacts.attachments {
            preflight_artifact_for_rotation(
                &attachment.path,
                &attachment.bytes,
                old_key,
                next_passphrase,
                &mut recovered_by_salt,
                false,
            )?;
        }
        for artifact in &artifacts.recovery {
            preflight_artifact_for_rotation(
                &artifact.path,
                &artifact.bytes,
                old_key,
                next_passphrase,
                &mut recovered_by_salt,
                false,
            )?;
        }
        let mut generation =
            snapshot_managed_sync_document_generations(sync_dir, None, false)?;
        require_captured_sync_attachment_generations(&generation, &artifacts.attachments)?;
        require_captured_sync_recovery_generations(&generation, &artifacts.recovery)?;
        require_no_managed_plaintext_document_generations(&generation)?;
        before_mutation()?;
        for artifact in &artifacts.recovery {
            let version = converge_rotation_artifact_generation_in_place(
                artifact,
                old_key,
                &next,
                next_passphrase,
                &mut recovered_by_salt,
            )?;
            set_expected_managed_sync_recovery_generation(
                &mut generation,
                &artifact.path,
                version,
            )?;
        }
        for attachment in &artifacts.attachments {
            let version = converge_rotation_artifact_generation_in_place(
                attachment,
                old_key,
                &next,
                next_passphrase,
                &mut recovered_by_salt,
            )?;
            set_expected_managed_sync_attachment_generation(
                &mut generation,
                &attachment.path,
                version,
            )?;
        }
        for document in &artifacts.documents {
            require_sync_document_generation(document)?;
            let version = rewrap_artifact_generation_in_place(
                &document.path,
                &document.bytes,
                &document.version,
                old_key,
                &next,
                next_passphrase,
                &mut recovered_by_salt,
            )?;
            set_expected_managed_sync_document_generation(
                &mut generation,
                &document.path,
                Some(version),
            )?;
        }
        require_no_managed_plaintext_document_generations(&generation)?;
        revalidate_sync_lock(&lock, sync_dir)?;
        finalize(&lock, &next, &generation)?;
        Ok(())
    })();
    release_sync_lock(&lock);
    result.map(|()| next)
}

fn require_file_backend_dir(
    app: &tauri::AppHandle,
    path: Option<String>,
) -> Result<PathBuf, String> {
    match path {
        Some(path) => resolve_sync_dir_granting_scope(app, path),
        None => configured_sync_dir(app)?.ok_or_else(|| "Sync path is not configured".to_string()),
    }
}

fn cached_key_or_err(app: &tauri::AppHandle) -> Result<[u8; KEY_LEN], String> {
    resolve_key_material(app)?
        .map(|material| material.key)
        .ok_or_else(|| terminal_error("sync encryption is not unlocked on this device"))
}

/// Turns the whole folder's remote artifact set into `.enc` counterparts and caches the key.
/// The enabled state is persisted only after the conversion has fully succeeded — the same
/// "never persist a backend flag before its first successful round-trip" rule the staged
/// credential family follows (#1034).
#[tauri::command(async)]
pub(crate) fn enable_sync_encryption(
    app: tauri::AppHandle,
    passphrase: String,
    path: Option<String>,
) -> Result<(), String> {
    let sync_dir = require_file_backend_dir(&app, path)?;
    enable_sync_encryption_in_dir_with(
        &sync_dir,
        &passphrase,
        || begin_sync_encryption_transition(&app, TRANSITION_ENABLE),
        |lock, material, generation| {
            finalize_enabled_file_generation_with(
                generation,
                material,
                || revalidate_sync_lock(lock, &sync_dir),
                |verified| {
                    persist_enabled_material_with_fence(&app, verified, || {
                        revalidate_sync_lock(lock, &sync_dir)
                    })
                },
            )
        },
    )?;
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn disable_sync_encryption(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<(), String> {
    let sync_dir = require_file_backend_dir(&app, path)?;
    let key = cached_key_or_err(&app)?;
    disable_sync_encryption_in_dir_with(
        &sync_dir,
        &key,
        || begin_sync_encryption_transition(&app, TRANSITION_DISABLE),
        |lock, generation| {
            revalidate_sync_lock(lock, &sync_dir)?;
            require_managed_sync_document_generations(generation)?;
            clear_encryption_state_with_fence(&app, || {
                revalidate_sync_lock(lock, &sync_dir)
            })
        },
    )
}

#[tauri::command(async)]
pub(crate) fn change_sync_encryption_passphrase(
    app: tauri::AppHandle,
    next_passphrase: String,
    path: Option<String>,
) -> Result<(), String> {
    let sync_dir = require_file_backend_dir(&app, path)?;
    let old_key = cached_key_or_err(&app)?;
    change_sync_encryption_passphrase_in_dir_with(
        &sync_dir,
        &old_key,
        &next_passphrase,
        || begin_sync_encryption_transition(&app, TRANSITION_CHANGE_PASSPHRASE),
        |lock, material, generation| {
            finalize_enabled_file_generation_with(
                generation,
                material,
                || revalidate_sync_lock(lock, &sync_dir),
                |verified| {
                    persist_enabled_material_with_fence(&app, verified, || {
                        revalidate_sync_lock(lock, &sync_dir)
                    })
                },
            )
        },
    )?;
    Ok(())
}

/// Core of the passphrase check, with the artifact read injected so the
/// stable-bytes rule is testable without an AppHandle.
///
/// An AES-GCM auth failure is also what a torn read of a file another device is
/// mid-writing produces (network mounts don't guarantee atomic visibility), and
/// reporting that as "wrong passphrase" sent a tester chasing a passphrase that
/// was correct (#1056). A wrong passphrase fails the same way against a settled
/// file, so an auth failure only counts once the bytes read stable.
fn verify_sync_passphrase_with_reread(
    passphrase: &str,
    artifact_label: &str,
    mut read_artifact: impl FnMut() -> Result<Vec<u8>, String>,
) -> Result<Option<SyncKeyMaterial>, String> {
    let mut bytes = read_artifact()?;
    // ponytail: bounded reread loop, not a folder lock — a concurrent writer can
    // still slip between the auth failure and the reread, and the next attempt
    // by the user covers that.
    for attempt in 0..3 {
        let header = match inspect_sync_artifact(&bytes) {
            SyncArtifactInspection::Encrypted(header) => header,
            SyncArtifactInspection::Unsupported(reason) => return Err(terminal_error(reason)),
            SyncArtifactInspection::Plaintext => {
                return Err(terminal_error(format!(
                    "{artifact_label} is not an encrypted sync document"
                )))
            }
        };
        let material = derive_sync_key_material(passphrase, header.salt, header.params)
            .map_err(|error| terminal_error(error))?;
        match decrypt_sync_artifact(&bytes, &material.key) {
            Ok(_) => return Ok(Some(material)),
            Err(SyncCryptoError::Auth) => {
                let reread = read_artifact()?;
                if reread == bytes || attempt == 2 {
                    return Ok(None);
                }
                bytes = reread;
            }
            Err(error) => return Err(terminal_error(error)),
        }
    }
    Ok(None)
}

fn provide_sync_encryption_passphrase_in_dir_with<BeforeFinalize, Persist>(
    sync_dir: &Path,
    passphrase: &str,
    before_finalize: BeforeFinalize,
    persist: Persist,
) -> Result<String, String>
where
    BeforeFinalize: FnOnce() -> Result<(), String>,
    Persist: FnOnce(&SyncFileLock, &SyncKeyMaterial) -> Result<(), String>,
{
    // Passphrase verification is a read-modify-persist operation over the remote folder's
    // exact generation. Hold the same lock as ordinary File Sync and transitions from the
    // first authentication read until the enabled material is durable; otherwise a writer can
    // replace the authenticated generation before the local key/state commit.
    let lock = acquire_sync_lock(sync_dir)?;
    let result = (|| {
        let encrypted = sync_dir.join(encrypted_artifact_name(DATA_FILE_NAME));
        let label = encrypted.display().to_string();
        let outcome = verify_sync_passphrase_with_reread(passphrase, &label, || {
            fs::read(&encrypted).map_err(|error| format!("Failed to read {label}: {error}"))
        })?;
        match outcome {
            Some(material) => {
                let generation = snapshot_managed_sync_document_generations(
                    sync_dir,
                    Some(&material),
                    true,
                )?;
                finalize_enabled_file_generation_with(
                    &generation,
                    &material,
                    || {
                        before_finalize()?;
                        revalidate_sync_lock(&lock, sync_dir)
                    },
                    |verified| persist(&lock, verified),
                )?;
                Ok("ok".to_string())
            }
            None => Ok("wrong-passphrase".to_string()),
        }
    })();
    release_sync_lock(&lock);
    result
}

/// Validates a passphrase against the folder's current `.enc` base document. Never mutates the
/// remote either way: a wrong passphrase is a plain answer, not an error and not a write.
#[tauri::command(async)]
pub(crate) fn provide_sync_encryption_passphrase(
    app: tauri::AppHandle,
    passphrase: String,
    path: Option<String>,
) -> Result<String, String> {
    let sync_dir = require_file_backend_dir(&app, path)?;
    provide_sync_encryption_passphrase_in_dir_with(
        &sync_dir,
        &passphrase,
        || Ok(()),
        |lock, verified| {
            persist_enabled_material_with_fence(&app, verified, || {
                revalidate_sync_lock(lock, &sync_dir)
            })
        },
    )
}

// tauri-plugin-fs declares `exists`, `mkdir`, `remove` and `rename` as plain
// `#[tauri::command]`, so each of those runs its syscall on the Tauri main
// thread. The attachment step of a file sync makes one `exists` per attachment
// plus a mkdir/rename/remove per copy against the sync folder, and on a slow
// mount (rclone/WinFSP, network share) that starves the Win32 message pump for
// the whole run — Windows paints "Mindwtr (Not Responding)" (#1037). These are
// the same four operations off the UI thread. Absolute paths only: the
// base-directory-relative plugin calls all land on local app data, which is
// never the slow side.
// The same two path families the fs plugin accepts for these calls: the runtime
// scope (the sync folder, granted by expand_tauri_fs_scope) and the managed data
// dir (granted through the static capability, which a non-plugin command cannot
// read back). Traversal and symlink components are rejected so a lexical grant
// cannot be redirected outside either allowed tree.
fn sync_fs_path_is_allowed(path: &Path, managed_dir: &Path, scope_allows: bool) -> bool {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| component == std::path::Component::ParentDir)
    {
        return false;
    }
    // Reject symlinks below the trust root only — never in the root's own
    // ancestry. macOS reaches real paths through symlinks (/var, /tmp, /home),
    // and symlinked $HOME/XDG data dirs are common on Linux, so walking from
    // "/" forbade every sync-folder operation for those setups (it also failed
    // this crate's macOS CI, whose runners have a symlinked /home). Below the
    // root the walk stays: a symlink lexically inside the managed dir can point
    // anywhere, which is the traversal this guard exists to stop.
    let Ok(suffix) = path.strip_prefix(managed_dir) else {
        // Not under the managed dir: the sync folder, reachable only through
        // the runtime fs scope. The scope grant (expand_tauri_fs_scope on the
        // user's own folder pick) is the authority there, matching the fs
        // plugin reachability these commands replaced (#1037) — and a sync
        // folder on a virtual mount may not answer per-component stats at all.
        return scope_allows;
    };
    let mut candidate = managed_dir.to_path_buf();
    for component in suffix.components() {
        candidate.push(component.as_os_str());
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => return false,
            Ok(_) => {}
            // Missing trailing components are valid for exists/create/write
            // operations. Their nearest existing ancestor was already checked.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        }
    }
    true
}

fn sync_fs_path(app: &tauri::AppHandle, path: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if sync_fs_path_is_allowed(
        &path,
        &crate::storage::get_data_dir(app),
        app.fs_scope().is_allowed(&path),
    ) {
        Ok(path)
    } else {
        Err(format!("forbidden path: {}", path.display()))
    }
}

#[cfg(test)]
const FILE_SYNC_ATTACHMENT_SCRATCH_PREFIX: &str = ".mindwtr-attachment-generation-";
#[cfg(test)]
const FILE_SYNC_ATTACHMENT_SCRATCH_SUFFIX: &str = ".tmp";

#[cfg(test)]
fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
fn is_file_sync_attachment_generation_target(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.split('.').any(is_sha256_hex))
}

#[cfg(test)]
fn verify_and_flush_file_sync_generation_scratch(
    scratch_path: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(scratch_path)
        .map_err(|error| format!("Failed to inspect attachment generation scratch: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("Attachment generation scratch must be a regular file".to_string());
    }
    if metadata.len() != expected_size {
        return Err("Attachment generation scratch size changed before publication".to_string());
    }

    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(scratch_path)
        .map_err(|error| format!("Failed to open attachment generation scratch: {error}"))?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read attachment generation scratch: {error}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "Attachment generation scratch size overflow".to_string())?;
        if total > expected_size {
            return Err(
                "Attachment generation scratch size changed before publication".to_string(),
            );
        }
        hasher.update(&buffer[..read]);
    }
    if total != expected_size
        || file
            .metadata()
            .map_err(|error| format!("Failed to restat attachment generation scratch: {error}"))?
            .len()
            != expected_size
    {
        return Err("Attachment generation scratch size changed before publication".to_string());
    }
    let actual_sha256 = bytes_to_hex(&hasher.finalize());
    if actual_sha256 != expected_sha256.to_ascii_lowercase() {
        return Err("Attachment generation scratch failed integrity verification".to_string());
    }
    file.sync_all()
        .map_err(|error| format!("Failed to flush attachment generation scratch: {error}"))?;
    drop(file);
    Ok(())
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum FileSyncAttachmentGenerationPublication {
    Published,
    AlreadyExists,
}

#[tauri::command(async)]
pub(crate) fn sync_fs_reserve_attachment_generation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileSyncLeaseState>,
    lease_token: String,
    target_path: String,
    expected_size: u64,
    expected_sha256: String,
) -> Result<PublicationReservation, String> {
    let target_path = PathBuf::from(target_path);
    with_file_sync_lease(&state, &lease_token, window.label(), |lease| {
        file_sync_attachment_publication::reserve(
            &crate::storage::get_data_dir(&app),
            &mut lease.publication_root,
            &target_path,
            expected_size,
            &expected_sha256,
        )
    })
}

#[cfg(test)]
fn publish_file_sync_attachment_generation_with<Replace, SyncParent>(
    scratch_path: &Path,
    target_path: &Path,
    expected_size: u64,
    expected_sha256: &str,
    replace: Replace,
    mut sync_parent: SyncParent,
) -> Result<FileSyncAttachmentGenerationPublication, String>
where
    Replace: FnOnce(&Path, &Path) -> std::io::Result<()>,
    SyncParent: FnMut(&Path) -> std::io::Result<()>,
{
    if scratch_path.parent() != target_path.parent() {
        return Err("Attachment generation publication must stay within one directory".to_string());
    }
    let scratch_name = scratch_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Attachment generation scratch has no valid file name".to_string())?;
    if !scratch_name.starts_with(FILE_SYNC_ATTACHMENT_SCRATCH_PREFIX)
        || !scratch_name.ends_with(FILE_SYNC_ATTACHMENT_SCRATCH_SUFFIX)
    {
        return Err("Attachment generation scratch name is invalid".to_string());
    }
    if !is_file_sync_attachment_generation_target(target_path) {
        return Err("Attachment generation target is not hash-qualified".to_string());
    }
    if !is_sha256_hex(expected_sha256) {
        return Err("Attachment generation expected SHA-256 is invalid".to_string());
    }

    verify_and_flush_file_sync_generation_scratch(scratch_path, expected_size, expected_sha256)?;
    match replace(scratch_path, target_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Ok(FileSyncAttachmentGenerationPublication::AlreadyExists);
        }
        Err(error) => {
            return Err(format!("Failed to publish attachment generation: {error}"));
        }
    }
    sync_parent(target_path)
        .map_err(|error| format!("Failed to flush attachment generation directory: {error}"))?;
    Ok(FileSyncAttachmentGenerationPublication::Published)
}

#[tauri::command(async)]
pub(crate) fn sync_fs_exists(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    sync_fs_path(&app, path)?
        .try_exists()
        .map_err(|error| error.to_string())
}

#[derive(serde::Serialize)]
pub(crate) struct SyncFsStat {
    /// Milliseconds since the Unix epoch, matching the JS side's `LocalFileStat.mtimeMs`.
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
    size: u64,
}

// #1057 (review S5): a linked attachment's path can point at the same slow mount as
// the sync folder itself, same as `sync_fs_exists` above — this must not go through
// the fs plugin's plain (main-thread) `stat` command for a non-managed-dir path.
#[tauri::command(async)]
pub(crate) fn sync_fs_stat(app: tauri::AppHandle, path: String) -> Result<SyncFsStat, String> {
    let metadata = fs::metadata(sync_fs_path(&app, path)?).map_err(|error| error.to_string())?;
    let mtime_ms = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    Ok(SyncFsStat {
        mtime_ms,
        size: metadata.len(),
    })
}

#[tauri::command(async)]
pub(crate) fn sync_fs_create_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    fs::create_dir_all(sync_fs_path(&app, path)?).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn sync_fs_remove_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // Idempotent like mobile's file-backend delete: a missing target means the
    // delete already happened (e.g. the user removed the file by hand), and an
    // error here would requeue it as a retryable pending attachment delete
    // that can never succeed (#1064).
    match fs::remove_file(sync_fs_path(&app, path)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command(async)]
pub(crate) fn sync_fs_rename(
    app: tauri::AppHandle,
    from: String,
    to: String,
) -> Result<(), String> {
    let from = sync_fs_path(&app, from)?;
    let to = sync_fs_path(&app, to)?;
    if from.parent() != to.parent() {
        return Err("sync file rename must stay within one directory".to_string());
    }
    if !fs::metadata(&from)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err(format!(
            "sync file rename source is not a file: {}",
            from.display()
        ));
    }
    fs::rename(from, to).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn sync_fs_publish_attachment_generation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileSyncLeaseState>,
    lease_token: String,
    operation_id: String,
) -> Result<FileSyncAttachmentGenerationPublication, String> {
    with_file_sync_lease(&state, &lease_token, window.label(), |lease| {
        let outcome = file_sync_attachment_publication::publish(
            &crate::storage::get_data_dir(&app),
            &mut lease.publication_root,
            &operation_id,
        )?;
        Ok(match outcome {
            PublicationAttempt::Published => FileSyncAttachmentGenerationPublication::Published,
            PublicationAttempt::AlreadyExists => {
                FileSyncAttachmentGenerationPublication::AlreadyExists
            }
        })
    })
}

#[tauri::command(async)]
pub(crate) fn sync_fs_abandon_attachment_generation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileSyncLeaseState>,
    lease_token: String,
    operation_id: String,
) -> Result<(), String> {
    with_file_sync_lease(&state, &lease_token, window.label(), |lease| {
        file_sync_attachment_publication::abandon(
            &crate::storage::get_data_dir(&app),
            &mut lease.publication_root,
            &operation_id,
        )
    })
}
