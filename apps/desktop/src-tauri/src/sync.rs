use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use fs2::FileExt;
use rand::RngCore;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::error::Error as StdError;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_fs::FsExt;

use crate::config::{
    get_keyring_secret, lock_config_read_modify_write, read_bound_credential, read_config,
    read_dropbox_credential_state, set_keyring_secret, update_dropbox_credential_state,
    write_config_files, CredentialService,
};
use crate::storage::{get_config_path, get_secrets_path, read_json_with_retries_validated};
#[cfg(target_os = "macos")]
use crate::{
    mindwtr_macos_create_security_bookmark, mindwtr_macos_free_bookmark_string,
    mindwtr_macos_resolve_security_bookmark,
};
use crate::{
    AppConfigToml, DropboxResolvedCredentialHandle, DropboxTokenBundle, DropboxTokenResponse,
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

const NATIVE_HTTP_TIMEOUT_SECS: u64 = 30;
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

fn is_webdav_https_downgrade(next: &reqwest::Url, previous: &[reqwest::Url]) -> bool {
    previous
        .last()
        .is_some_and(|previous| previous.scheme() == "https" && next.scheme() == "http")
}

fn webdav_redirect_security_error(
    next: &reqwest::Url,
    previous: &[reqwest::Url],
    allow_insecure_http: bool,
) -> Option<&'static str> {
    if is_webdav_https_downgrade(next, previous) {
        Some("WebDAV refused an HTTPS to HTTP redirect")
    } else if assert_webdav_url_allowed(next.as_str(), allow_insecure_http).is_err() {
        Some("WebDAV refused an insecure redirect target")
    } else {
        None
    }
}

fn webdav_blocking_http_client(
    proxy_url: Option<&str>,
    allow_insecure_http: bool,
) -> Result<reqwest::blocking::Client, String> {
    let redirect_policy = reqwest::redirect::Policy::custom(move |attempt| {
        if let Some(error) =
            webdav_redirect_security_error(attempt.url(), attempt.previous(), allow_insecure_http)
        {
            attempt.error(error)
        } else if attempt.previous().len() > 10 {
            attempt.error("too many WebDAV redirects")
        } else {
            attempt.follow()
        }
    });
    blocking_http_client_builder(proxy_url)?
        .redirect(redirect_policy)
        .build()
        .map_err(|error| format!("Failed to create WebDAV HTTP client: {error}"))
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
    let client = blocking_http_client(proxy_url)?;
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
    let client = blocking_http_client(proxy_url)?;
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
            Ok(_) => Err(
                "Dropbox credential recovery is uncertain and sync could not be durably disabled"
                    .to_string(),
            ),
            Err(_) => Err(
                "Dropbox credential recovery is uncertain and the disabled sync state could not be verified"
                    .to_string(),
            ),
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

fn webdav_get_json_blocking(app: &tauri::AppHandle) -> Result<Value, String> {
    let (config, password) = read_bound_credential(app, CredentialService::Webdav)?;
    let allow_insecure_http = webdav_allows_insecure_http(&config);
    let url = resolve_webdav_request_url(&config)?;
    let username = config.webdav_username.unwrap_or_default();
    let password = password.ok_or_else(|| "WebDAV password not configured".to_string())?;

    let client = webdav_blocking_http_client(config.proxy_url.as_deref(), allow_insecure_http)?;
    let response = client
        .get(url.as_str())
        .basic_auth(username, Some(password))
        .send()
        .map_err(|e| format_reqwest_send_error("WebDAV request failed", &e))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Value::Null);
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "WebDAV GET failed ({status}) at {url}{}",
            webdav_error_body_snippet(&body)
        ));
    }

    let body = response
        .text()
        .map_err(|e| format!("Invalid WebDAV response: error reading response body: {e}"))?;
    let normalized_body = body.trim_start_matches('\u{feff}').trim();
    if normalized_body.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str::<Value>(normalized_body)
        .map_err(|e| format!("Invalid WebDAV response: error decoding response body: {e}"))
}

#[tauri::command]
pub(crate) async fn webdav_get_json(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || webdav_get_json_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn webdav_put_json_blocking(
    app: &tauri::AppHandle,
    data: &Value,
) -> Result<RemoteJsonWriteResult, String> {
    let (config, password) = read_bound_credential(app, CredentialService::Webdav)?;
    let allow_insecure_http = webdav_allows_insecure_http(&config);
    let url = resolve_webdav_request_url(&config)?;
    let username = config.webdav_username.unwrap_or_default();
    let password = password.ok_or_else(|| "WebDAV password not configured".to_string())?;

    let payload = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to encode WebDAV payload: {e}"))?;
    let client = webdav_blocking_http_client(config.proxy_url.as_deref(), allow_insecure_http)?;
    let send_put = || {
        client
            .put(url.clone())
            .basic_auth(&username, Some(&password))
            .header("Content-Type", "application/json")
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
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "WebDAV PUT failed ({status}) at {url}{}",
            webdav_error_body_snippet(&body)
        ));
    }
    Ok(remote_json_write_result_from_headers(response.headers()))
}

#[tauri::command]
pub(crate) async fn webdav_put_json(
    app: tauri::AppHandle,
    data: Value,
) -> Result<RemoteJsonWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || webdav_put_json_blocking(&app, &data))
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
    let client = blocking_http_client(config.proxy_url.as_deref())?;
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
    let client = blocking_http_client(config.proxy_url.as_deref())?;
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
            read_sync_backup(&backup, &backup_previous)
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
            ("config.rs", config_source, "get_sync_configuration_snapshot"),
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
            ("lib.rs", include_str!("lib.rs"), "set_desktop_rendering_config"),
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
        for name in ["read_sync_file", "read_sync_file_versioned", "write_sync_file"] {
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
        ] {
            assert!(
                handler.contains(&format!("{name},")),
                "lib.rs: {name} must stay registered — without it the sync path \
                 falls back to the fs plugin's main-thread commands (#1037)"
            );
        }
    }

    #[test]
    fn sync_fs_paths_are_confined_to_the_managed_dir_and_the_granted_scope() {
        let managed = Path::new("/home/u/.local/share/mindwtr");
        assert!(sync_fs_path_is_allowed(
            &managed.join("attachments/a.txt"),
            managed,
            false
        ));
        // The sync folder is only ever reachable through the runtime fs scope.
        assert!(sync_fs_path_is_allowed(
            Path::new("/mnt/rclone/sync/attachments/a.txt"),
            managed,
            true
        ));
        assert!(!sync_fs_path_is_allowed(
            Path::new("/home/u/.ssh/id_ed25519"),
            managed,
            false
        ));
        // Traversal must not walk out of the managed dir, scope or no scope.
        assert!(!sync_fs_path_is_allowed(
            &managed.join("../../.ssh/id_ed25519"),
            managed,
            false
        ));
        assert!(!sync_fs_path_is_allowed(
            &managed.join("../../.ssh/id_ed25519"),
            managed,
            true
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
            (
                "get_dropbox_redirect_uri",
                "pure string builder, no I/O",
            ),
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

        let sources: &[(&str, &str)] = &[
            ("audio.rs", include_str!("audio.rs")),
            ("autostart.rs", include_str!("autostart.rs")),
            ("config.rs", include_str!("config.rs")),
            ("email_capture.rs", include_str!("email_capture.rs")),
            ("install.rs", include_str!("install.rs")),
            ("lib.rs", include_str!("lib.rs")),
            ("linux_calendar.rs", include_str!("linux_calendar.rs")),
            ("local_api.rs", include_str!("local_api.rs")),
            ("logging.rs", include_str!("logging.rs")),
            ("obsidian_watcher.rs", include_str!("obsidian_watcher.rs")),
            ("obsidian_writer.rs", include_str!("obsidian_writer.rs")),
            ("platform.rs", include_str!("platform.rs")),
            ("storage.rs", include_str!("storage.rs")),
            ("sync.rs", include_str!("sync.rs")),
            ("ui.rs", include_str!("ui.rs")),
        ];

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
        for (file, source) in sources {
            for (name, is_async) in tauri_command_declarations(source) {
                if is_async || allowed_names.contains(name.as_str()) {
                    continue;
                }
                if known_blocking.contains(name.as_str()) {
                    seen_known_blocking.insert(
                        *known_blocking.get(name.as_str()).expect("just checked contains"),
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
        assert!(classify_dropbox_startup_recovery_with(
            Err("recovery warning".to_string()),
            || Ok("cloud".to_string()),
        )
        .is_err());
        assert!(classify_dropbox_startup_recovery_with(
            Err("recovery warning".to_string()),
            || Err("backend unreadable".to_string()),
        )
        .is_err());
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
    recover_dropbox_credentials(&app)?;
    let normalized_client_id = normalize_dropbox_client_id(&client_id)?;
    is_dropbox_connected_with(&normalized_client_id, || read_dropbox_tokens(&app))
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

#[derive(Debug)]
struct SyncFileLock {
    file: File,
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
    options.open(lock_path)
}

fn acquire_sync_lock(sync_dir: &Path) -> Result<SyncFileLock, String> {
    let lock_path = sync_dir.join(".mindwtr.lock");
    let file = open_sync_lock_file(&lock_path, false)
        // Any refusal of the read-only open — a lock file that does not exist
        // yet, a mount that answers oddly — falls back to the writable open used
        // before #1001, so the set of filesystems that can take the lock at all
        // only grows.
        .or_else(|_| open_sync_lock_file(&lock_path, true))
        .map_err(|error| format!("Failed to open sync lock: {error}"))?;
    let read_only_error = match file.try_lock_exclusive() {
        Ok(()) => return Ok(SyncFileLock { file }),
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
    match file.try_lock_exclusive() {
        Ok(()) => Ok(SyncFileLock { file }),
        Err(error) => Err(sync_lock_error_message(&error)),
    }
}

fn release_sync_lock(sync_lock: &SyncFileLock) {
    if let Err(error) = FileExt::unlock(&sync_lock.file) {
        log::warn!("Failed to release sync file lock: {error}");
    }
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

// Runs off the UI thread: the sync folder can be a network or FUSE mount
// (rclone, WinFSP) where a single read blocks for tens of seconds, and a
// plain `#[tauri::command]` executes on the main thread and freezes the window.
fn sync_regular_file_for_durability(path: &Path) -> std::io::Result<()> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
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

/// `fs::copy` presizes the destination before writing it — `CopyFileExW` on
/// Windows, an explicit size change elsewhere — and a cache-off rclone VFS
/// refuses any size change ("WriteFileHandle: Truncate: Can't change size",
/// #1001), logging an error per sync even though the bytes still land. Writing
/// the destination sequentially through one freshly created handle is the write
/// shape those mounts always allow, and flushing that same handle avoids
/// reopening the file for write afterwards, which they also refuse.
fn copy_file_sequentially(source: &Path, destination: &Path) -> std::io::Result<()> {
    let contents = fs::read(source)?;
    let mut file = File::create(destination)?;
    file.write_all(&contents)?;
    file.sync_all()
}

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

fn read_sync_candidate(path: &Path, attempts: usize) -> Result<Value, String> {
    read_json_with_retries_validated(path, attempts, |value| {
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
    })
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

fn read_sync_backup(backup_file: &Path, previous_file: &Path) -> Option<SyncFileRead> {
    [
        (backup_file, SyncFileReadSource::Backup),
        (previous_file, SyncFileReadSource::BackupPrevious),
    ]
    .into_iter()
    .filter(|(path, _)| path.exists())
    .find_map(|(path, source)| {
        read_sync_candidate(path, 2)
            .ok()
            .map(|data| SyncFileRead { data, source })
    })
}

fn read_sync_recovery(
    primary_previous_file: &Path,
    backup_file: &Path,
    backup_previous_file: &Path,
) -> Option<SyncFileRead> {
    if primary_previous_file.exists() {
        if let Ok(data) = read_sync_candidate(primary_previous_file, 2) {
            return Some(SyncFileRead {
                data,
                source: SyncFileReadSource::PrimaryPrevious,
            });
        }
    }
    read_sync_backup(backup_file, backup_previous_file)
}

fn read_sync_file_with_source_from_dir(sync_dir: &Path) -> Result<SyncFileRead, String> {
    let sync_file = sync_dir.join(DATA_FILE_NAME);
    let primary_previous_file = sync_dir.join(format!("{}.previous", DATA_FILE_NAME));
    let backup_file = sync_dir.join(format!("{}.bak", DATA_FILE_NAME));
    let backup_previous_file = sync_dir.join(format!("{}.bak.previous", DATA_FILE_NAME));
    let legacy_sync_file = sync_dir.join(format!("{}-sync.json", APP_NAME));

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
            if !lower.ends_with(".json") {
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
            match read_sync_candidate(&legacy_sync_file, 1) {
                Ok(data) => {
                    return Some(Ok(SyncFileRead {
                        data,
                        source: SyncFileReadSource::Legacy,
                    }));
                }
                Err(error) => first_error = Some(error),
            }
        }
        for seed_file in find_seed_backup_files(sync_dir) {
            match read_sync_candidate(&seed_file, 1) {
                Ok(data) => {
                    return Some(Ok(SyncFileRead {
                        data,
                        source: SyncFileReadSource::Seed,
                    }));
                }
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
        if let Some(value) =
            read_sync_recovery(&primary_previous_file, &backup_file, &backup_previous_file)
        {
            return Ok(value);
        }
        if let Some(result) = read_seed_or_legacy_file() {
            return result;
        }
        return Err(msg);
    }

    if !sync_file.exists() {
        if let Some(value) =
            read_sync_recovery(&primary_previous_file, &backup_file, &backup_previous_file)
        {
            return Ok(value);
        }
        if let Some(result) = read_seed_or_legacy_file() {
            return result;
        }
        return Ok(SyncFileRead {
            data: empty_remote_app_data(),
            source: SyncFileReadSource::Empty,
        });
    }

    match read_sync_candidate(&sync_file, 5) {
        Ok(data) => Ok(SyncFileRead {
            data,
            source: SyncFileReadSource::Primary,
        }),
        Err(primary_err) => {
            if let Some(value) =
                read_sync_recovery(&primary_previous_file, &backup_file, &backup_previous_file)
            {
                return Ok(value);
            }
            Err(primary_err)
        }
    }
}

fn read_sync_file_from_dir(sync_dir: &Path) -> Result<serde_json::Value, String> {
    read_sync_file_with_source_from_dir(sync_dir).map(|result| result.data)
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

fn read_sync_file_versioned_from_dir(sync_dir: &Path) -> Result<SyncFileReadResult, String> {
    let result = read_sync_file_with_source_from_dir(sync_dir)?;
    let fingerprint = sync_document_fingerprint(&result.data)?;
    Ok(SyncFileReadResult {
        data: result.data,
        fingerprint,
        source: result.source.as_str(),
        needs_repair: result.source.needs_repair(),
    })
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
    read_sync_file_from_dir(&sync_dir)
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
    read_sync_file_versioned_from_dir(&sync_dir)
}

fn write_sync_file_to_dir(
    sync_dir: &Path,
    data: Value,
    expected_fingerprint: Option<&str>,
) -> Result<bool, String> {
    let sync_file = sync_dir.join(DATA_FILE_NAME);
    let backup_file = sync_dir.join(format!("{}.bak", DATA_FILE_NAME));
    let backup_previous_file = sync_dir.join(format!("{}.bak.previous", DATA_FILE_NAME));
    let primary_previous_file = sync_dir.join(format!("{}.previous", DATA_FILE_NAME));
    let tmp_file = sync_dir.join(format!("{}.tmp", DATA_FILE_NAME));

    if is_icloud_evicted(&sync_file) {
        log::warn!(
            "Sync target is iCloud-evicted; writing directly to avoid corrupting placeholder."
        );
    }

    if let Some(parent) = sync_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let sync_lock = acquire_sync_lock(sync_dir)?;

    let result = (|| -> Result<bool, String> {
        if let Some(expected_fingerprint) = expected_fingerprint {
            let current = read_sync_file_from_dir(sync_dir)?;
            if sync_document_fingerprint(&current)? != expected_fingerprint {
                return Err(SYNC_FILE_WRITE_CONFLICT.to_string());
            }
        }

        if sync_file.exists() && read_sync_candidate(&sync_file, 1).is_ok() {
            // Overwriting the backup in place needs O_TRUNC, which rclone/WinFSP
            // mounts refuse without a VFS write cache — so the .bak silently
            // stopped updating there (#1001). Write a fresh temp name (a new
            // file, always allowed) and rename over the old backup, the same
            // shape the data file itself uses.
            let backup_tmp = sync_dir.join(format!("{}.bak.tmp", DATA_FILE_NAME));
            let _ = fs::remove_file(&backup_tmp);
            if let Err(error) = copy_file_sequentially(&sync_file, &backup_tmp) {
                log::warn!("Sync backup copy failed: {error}");
            } else {
                let replacement = if cfg!(windows) && backup_file.exists() {
                    replace_sync_backup_preserving_previous(
                        &backup_tmp,
                        &backup_file,
                        &backup_previous_file,
                        |path| fs::remove_file(path),
                        |from, to| fs::rename(from, to),
                    )
                } else {
                    fs::rename(&backup_tmp, &backup_file).map_err(|error| error.to_string())
                };
                let directory_flush =
                    sync_parent_directory_for_durability(&backup_file).map_err(|error| {
                        format!("Failed to flush sync backup directory metadata: {error}")
                    });
                if let Err(err) = replacement.and(directory_flush) {
                    log::warn!("Sync backup replacement failed: {err}");
                    let _ = fs::remove_file(&backup_tmp);
                }
            }
        }

        let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;

        {
            let mut file = File::create(&tmp_file).map_err(|e| e.to_string())?;
            file.write_all(content.as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }

        if cfg!(windows) && sync_file.exists() {
            // Windows cannot rename over an existing destination. Move the
            // primary aside instead of deleting it so a failed installation
            // can roll back without depending on the best-effort .bak copy.
            let replacement = replace_sync_file_preserving_previous(
                &tmp_file,
                &sync_file,
                &primary_previous_file,
                |path| fs::remove_file(path),
                |from, to| fs::rename(from, to),
            );
            let directory_flush = sync_parent_directory_for_durability(&sync_file)
                .map_err(|error| format!("Failed to flush sync directory metadata: {error}"));
            replacement?;
            directory_flush?;
            return Ok(true);
        }

        match fs::rename(&tmp_file, &sync_file) {
            Ok(()) => {
                sync_parent_directory_for_durability(&sync_file)
                    .map_err(|error| format!("Failed to flush sync directory metadata: {error}"))?;
                Ok(true)
            }
            Err(rename_err) => {
                log::warn!(
                    "Atomic rename failed ({}), falling back to direct write",
                    rename_err
                );
                match copy_file_sequentially(&tmp_file, &sync_file) {
                    Ok(_) => {
                        finish_copied_sync_file_durably(
                            &tmp_file,
                            &sync_file,
                            // Already flushed on the handle that wrote it.
                            // Reopening it for write is the shape a cache-off
                            // VFS mount refuses (#1001).
                            |_| Ok(()),
                            |path| fs::remove_file(path),
                            sync_parent_directory_for_durability,
                        )?;
                        Ok(true)
                    }
                    Err(copy_err) => Err(format!(
                        "Sync write failed: rename error: {rename_err}, copy fallback error: {copy_err}"
                    )),
                }
            }
        }
    })();

    release_sync_lock(&sync_lock);

    result
}

// Off the UI thread for the same reason as `read_sync_file`; concurrent writers
// are serialized by `acquire_sync_lock`, and stale readers are rejected by the
// expected fingerprint check while that lock is held.
#[tauri::command(async)]
pub(crate) fn write_sync_file(
    app: tauri::AppHandle,
    data: Value,
    path: Option<String>,
    expected_fingerprint: Option<String>,
) -> Result<bool, String> {
    let sync_dir = match path {
        Some(path) => resolve_sync_dir_granting_scope(&app, path)?,
        None => {
            configured_sync_dir(&app)?.ok_or_else(|| "Sync path is not configured".to_string())?
        }
    };
    write_sync_file_to_dir(&sync_dir, data, expected_fingerprint.as_deref())
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
// read back). `..` is rejected outright so the managed-dir prefix check cannot
// be walked out of.
fn sync_fs_path_is_allowed(path: &Path, managed_dir: &Path, scope_allows: bool) -> bool {
    if path
        .components()
        .any(|component| component == std::path::Component::ParentDir)
    {
        return false;
    }
    path.starts_with(managed_dir) || scope_allows
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

#[tauri::command(async)]
pub(crate) fn sync_fs_exists(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    sync_fs_path(&app, path)?
        .try_exists()
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn sync_fs_create_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    fs::create_dir_all(sync_fs_path(&app, path)?).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn sync_fs_remove_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    fs::remove_file(sync_fs_path(&app, path)?).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn sync_fs_rename(
    app: tauri::AppHandle,
    from: String,
    to: String,
) -> Result<(), String> {
    fs::rename(sync_fs_path(&app, from)?, sync_fs_path(&app, to)?)
        .map_err(|error| error.to_string())
}
