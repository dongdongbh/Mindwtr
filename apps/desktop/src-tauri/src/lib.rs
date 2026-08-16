// The fully-populated round-trip test fixtures exceed serde_json::json!'s
// default macro recursion depth.
#![recursion_limit = "256"]

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use keyring::{Entry, Error as KeyringError};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::env;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
#[cfg(target_os = "macos")]
use std::os::raw::c_char;
#[cfg(target_os = "linux")]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::image::Image;
#[cfg(target_os = "macos")]
use tauri::menu::HELP_SUBMENU_ID;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use time::OffsetDateTime;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

mod audio;
mod autostart;
mod config;
mod email_capture;
mod install;
mod linux_calendar;
mod local_api;
mod logging;
mod obsidian_paths;
mod obsidian_watcher;
mod obsidian_writer;
mod platform;
mod storage;
mod sync;
mod ui;
mod window_state;

use audio::{
    download_parakeet_model, download_whisper_model, start_audio_recording, stop_audio_recording,
    transcribe_parakeet, transcribe_whisper, AudioRecorderState,
};
use autostart::{get_launch_at_startup_enabled, set_launch_at_startup_enabled};
use config::{
    check_obsidian_vault_marker, expand_obsidian_vault_scope, get_ai_key, get_cloud_config,
    get_external_calendars, get_obsidian_config, get_sync_backend, get_sync_cloud_provider,
    get_sync_cloud_provider_state, get_sync_configuration_snapshot, get_webdav_config,
    get_webdav_password, list_obsidian_vaults, read_external_calendar_file, set_ai_key,
    set_cloud_config, set_external_calendars, set_network_proxy, set_obsidian_config,
    set_sync_backend, set_sync_cloud_provider, set_webdav_config,
};
use email_capture::{
    email_capture_commit, email_capture_poll, get_email_capture_config, set_email_capture_config,
};
use install::{
    check_microsoft_store_update, diagnostics_enabled, get_install_source, get_linux_distro,
    is_flatpak, is_niri_session,
};
use linux_calendar::{
    create_linux_calendar_event, delete_linux_calendar_event, ensure_linux_mindwtr_calendar,
    get_linux_calendar_events, get_linux_calendar_permission_status, get_linux_writable_calendars,
    request_linux_calendar_permission, update_linux_calendar_event,
};
use local_api::{
    get_local_api_server_status, set_local_api_server_config, start_configured_local_api_server,
    LocalApiServerState,
};
use logging::{append_log_line, append_native_log_line, clear_log_file};
use obsidian_paths::default_obsidian_inbox_file;
use obsidian_watcher::{start_obsidian_watcher, stop_obsidian_watcher, ObsidianWatcherState};
use obsidian_writer::{
    obsidian_create_task, obsidian_create_tasknotes, obsidian_toggle_task,
    obsidian_toggle_tasknotes,
};
use platform::{
    cloudkit_account_status, cloudkit_consume_pending_remote_change, cloudkit_delete_records,
    cloudkit_ensure_subscription, cloudkit_ensure_zone, cloudkit_fetch_all_records,
    cloudkit_fetch_attachment_asset, cloudkit_fetch_changes, cloudkit_register_for_notifications,
    cloudkit_save_attachment_asset, cloudkit_save_records, create_macos_calendar_event,
    delete_macos_calendar_event, ensure_macos_mindwtr_calendar, get_macos_calendar_events,
    get_macos_calendar_permission_status, get_macos_writable_calendars, get_managed_data_dir,
    import_attachment_file, migrate_portable_attachments, open_path,
    request_macos_calendar_permission, set_macos_activation_policy, update_macos_calendar_event,
};
use storage::{
    create_data_snapshot, delete_calendar_sync_entry, get_all_calendar_sync_entries,
    get_calendar_sync_entry, get_config_path_for_startup, get_data, get_data_path_cmd,
    get_db_path_cmd, list_data_snapshots, query_tasks, read_data_json, restore_data_snapshot,
    save_data, save_task, search_fts, upsert_calendar_sync_entry,
};
use sync::{
    clear_sync_path, cloud_get_json, cloud_put_json, connect_dropbox,
    discard_staged_dropbox_credentials, disconnect_dropbox, finalize_staged_dropbox_credentials,
    get_dropbox_access_token, get_dropbox_redirect_uri, get_sync_path, is_dropbox_connected,
    promote_staged_dropbox_credentials, read_sync_file, read_sync_file_versioned,
    recover_dropbox_credentials_before_sync_configuration, recover_dropbox_credentials_on_startup,
    rollback_staged_dropbox_credentials, set_sync_path, sync_fs_create_dir, sync_fs_exists,
    sync_fs_remove_file, sync_fs_rename, webdav_get_json, webdav_put_json, write_sync_file,
    DropboxStagedCredentialState, DropboxStartupRecoveryOutcome,
};
use ui::{
    acknowledge_close_request, apply_global_quick_add_shortcut, consume_quick_add_pending,
    create_quick_add_window, get_system_theme_preference, hide_quick_add_window,
    hide_quick_add_window_for_app, notify_ui_ready, quit_app, reveal_main_window_after_timeout,
    set_global_quick_add_shortcut, set_tray_tooltip, set_tray_visible, show_main,
    show_quick_add_window, MainWindowReveal,
};

#[cfg(any(target_os = "windows", target_os = "linux", test))]
use config::read_config_toml;
pub(crate) use config::{
    emit_keyring_fallback_warning, lock_config_read_modify_write, parse_toml_string_value,
    read_bound_credential, read_config, update_bound_credential, write_config_files,
    CredentialSecretUpdate, CredentialService,
};
#[cfg(test)]
use install::parse_flatpak_install_channel;
pub(crate) use storage::{ensure_data_file, get_config_path, get_data_dir, get_secrets_path};
pub(crate) use sync::expand_tauri_fs_scope;
#[cfg(target_os = "macos")]
use sync::resolve_sync_path_bookmark;

/// App name used for config directories and files
const APP_NAME: &str = "mindwtr";
const CONFIG_FILE_NAME: &str = "config.toml";
const SECRETS_FILE_NAME: &str = "secrets.toml";
const DROPBOX_CREDENTIAL_STATE_FILE_NAME: &str = "dropbox-credential-state.json";
const DROPBOX_CREDENTIAL_STATE_VERSION: u8 = 1;
const DATA_FILE_NAME: &str = "data.json";
const DB_FILE_NAME: &str = "mindwtr.db";
const KEYRING_WEB_DAV_PASSWORD: &str = "webdav_password";
const KEYRING_CLOUD_TOKEN: &str = "cloud_token";
const KEYRING_DROPBOX_TOKENS: &str = "dropbox_tokens";
const KEYRING_AI_OPENAI: &str = "ai_key_openai";
const KEYRING_AI_ANTHROPIC: &str = "ai_key_anthropic";
const KEYRING_AI_GEMINI: &str = "ai_key_gemini";
const KEYRING_EMAIL_CAPTURE_PASSWORD: &str = "email_capture_password";
const DROPBOX_AUTH_ENDPOINT: &str = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_ENDPOINT: &str = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_REVOKE_ENDPOINT: &str = "https://api.dropboxapi.com/2/auth/token/revoke";
const DROPBOX_REDIRECT_HOST: &str = "127.0.0.1";
const DROPBOX_REDIRECT_PORT: u16 = 53682;
const DROPBOX_REDIRECT_PATH: &str = "/oauth/dropbox/callback";
const DROPBOX_SCOPES: &str = "files.content.read files.content.write files.metadata.read";
const DROPBOX_OAUTH_TIMEOUT_SECS: u64 = 180;
const DROPBOX_TOKEN_REFRESH_SKEW_MS: i64 = 60_000;
const DROPBOX_DEFAULT_TOKEN_LIFETIME_SECS: i64 = 4 * 60 * 60;
const QUICK_ADD_CLI_FLAG: &str = "--quick-add";
// Written into the autostart entry's own command line (see the autostart
// plugin builder in `run()`) so a launch caused by that entry can be told
// apart from a manual double-click (#928).
const STARTUP_LAUNCH_CLI_FLAG: &str = "--startup";
#[cfg(target_os = "linux")]
const FLATPAK_INSTANCE_REQUEST_SHOW: &str = "show\n";
#[cfg(target_os = "linux")]
const FLATPAK_INSTANCE_REQUEST_QUICK_ADD: &str = "quick-add\n";
#[cfg(target_os = "linux")]
const FLATPAK_INSTANCE_SOCKET_FILE_NAME: &str = "instance.sock";
#[cfg(target_os = "linux")]
const TRAY_ICON_DIR_NAME: &str = "tray-icon";
const QUICK_ADD_WINDOW_LABEL: &str = "quick-add";
const QUICK_ADD_WINDOW_URL: &str = "index.html?quickAddWindow=1";
const QUICK_ADD_TARGET_MAIN: &str = "main";
const QUICK_ADD_TARGET_WINDOW: &str = "quick-add-window";
const GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT: &str = "Control+Alt+M";
const GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N: &str = "Control+Alt+N";
const GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q: &str = "Control+Alt+Q";
const GLOBAL_QUICK_ADD_SHORTCUT_LEGACY: &str = "CommandOrControl+Shift+A";
const GLOBAL_QUICK_ADD_SHORTCUT_DISABLED: &str = "disabled";
#[cfg(any(target_os = "windows", test))]
const WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
#[cfg(any(target_os = "windows", test))]
const WEBVIEW2_DISABLE_GPU_ARG: &str = "--disable-gpu";
#[cfg(any(target_os = "windows", test))]
const WEBVIEW2_PHONE_HOME_ARGS: [&str; 3] = [
    "--disable-component-update",
    "--disable-domain-reliability",
    "--no-pings",
];
#[cfg(any(target_os = "windows", test))]
const WEBVIEW2_DISABLE_FEATURES_PREFIX: &str = "--disable-features=";
// wry supplies these itself, but only while the app passes no browser arguments
// of its own (wry 0.53 webview2/mod.rs). This environment value can replace that
// block wholesale, so carry the defaults here or Windows silently loses the
// WebView2 mini-menu suppression, SmartScreen (phone-home traffic #909 removed)
// and gesture-free audio playback for the Pomodoro alarm (#913).
#[cfg(any(target_os = "windows", test))]
const WEBVIEW2_WRY_DEFAULT_DISABLED_FEATURES: [&str; 3] =
    ["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"];
#[cfg(any(target_os = "windows", test))]
const WEBVIEW2_AUTOPLAY_ARG: &str = "--autoplay-policy=no-user-gesture-required";
#[cfg(any(target_os = "linux", test))]
const WEBKIT_DISABLE_DMABUF_RENDERER_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
#[cfg(any(target_os = "linux", test))]
const WEBKIT_DISABLE_DMABUF_RENDERER_VALUE: &str = "1";
#[cfg(any(target_os = "linux", test))]
const WEBKIT_DISABLE_COMPOSITING_MODE_ENV: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
#[cfg(any(target_os = "linux", test))]
const WEBKIT_DISABLE_COMPOSITING_MODE_VALUE: &str = "1";
#[cfg(any(target_os = "linux", test))]
const MINDWTR_WEBKIT_ENABLE_DMABUF_ENV: &str = "MINDWTR_WEBKIT_ENABLE_DMABUF";

#[cfg(target_os = "linux")]
fn flatpak_notification_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let random = rand::thread_rng().next_u32();
    format!("mindwtr-{millis}-{random}")
}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn send_flatpak_notification(title: String, body: Option<String>) -> Result<(), String> {
    if !is_flatpak() {
        return Err("Flatpak notification portal is only available inside Flatpak".to_string());
    }

    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Err("Notification title is required".to_string());
    }

    let mut notification = ashpd::desktop::notification::Notification::new(trimmed_title)
        .priority(ashpd::desktop::notification::Priority::Normal);
    if let Some(body) = body
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        notification = notification.body(body);
    }

    let proxy = ashpd::desktop::notification::NotificationProxy::new()
        .await
        .map_err(|error| format!("Failed to connect to notification portal: {error}"))?;
    proxy
        .add_notification(&flatpak_notification_id(), notification)
        .await
        .map_err(|error| format!("Failed to send notification through portal: {error}"))
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
async fn send_flatpak_notification(_title: String, _body: Option<String>) -> Result<(), String> {
    Err("Flatpak notification portal is only available on Linux".to_string())
}

#[cfg(target_os = "macos")]
const MENU_HELP_DOCS_ID: &str = "help_docs";
#[cfg(target_os = "macos")]
const MENU_HELP_ISSUES_ID: &str = "help_report_issue";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Serialize, Deserialize, Default)]
struct LegacyAppConfigJson {
    data_file_path: Option<String>,
    sync_path: Option<String>,
}

// Field order here is the on-disk key order (matches every config.toml/
// secrets.toml written by shipped versions): `toml::to_string` emits struct
// fields in declaration order, so reordering this struct changes file layout.
// Add new fields at the end.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
struct AppConfigToml {
    #[serde(skip_serializing_if = "Option::is_none")]
    sync_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sync_path_bookmark: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sync_backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    webdav_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    webdav_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    webdav_password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    webdav_allow_insecure_http: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    webdav_allow_weak_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cloud_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cloud_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cloud_allow_insecure_http: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dropbox_tokens: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    obsidian_config: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    external_calendars: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ai_key_openai: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ai_key_anthropic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ai_key_gemini: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email_capture_config: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email_capture_password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_api_enabled: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_api_port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_api_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disable_hardware_acceleration: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    autostart_startup_flag_migrated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dropbox_promotion_journal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sync_cloud_provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DropboxCredentialStateFile {
    version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_fallback: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    promotion_journal: Option<String>,
    #[serde(default = "default_sync_backend_marker")]
    sync_backend_marker: String,
    #[serde(default = "default_sync_cloud_provider")]
    cloud_provider: String,
    #[serde(default = "default_sync_cloud_provider_authority")]
    cloud_provider_authority: String,
    #[serde(default)]
    generation: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    resolved_credential_handles: Vec<DropboxResolvedCredentialHandle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DropboxResolvedCredentialHandle {
    handle_fingerprint: String,
    client_id: String,
    candidate_fingerprint: String,
    resolved_at_ms: i64,
}

fn default_sync_backend_marker() -> String {
    "off".to_string()
}

fn default_sync_cloud_provider() -> String {
    "selfhosted".to_string()
}

fn default_sync_cloud_provider_authority() -> String {
    "uninitialized".to_string()
}

impl Default for DropboxCredentialStateFile {
    fn default() -> Self {
        Self {
            version: DROPBOX_CREDENTIAL_STATE_VERSION,
            token_fallback: None,
            promotion_journal: None,
            sync_backend_marker: default_sync_backend_marker(),
            cloud_provider: default_sync_cloud_provider(),
            cloud_provider_authority: default_sync_cloud_provider_authority(),
            generation: 0,
            resolved_credential_handles: Vec::new(),
        }
    }
}

static DROPBOX_CREDENTIAL_STATE_MUTEX: Mutex<()> = Mutex::new(());

fn default_obsidian_scan_folders() -> Vec<String> {
    vec!["/".to_string()]
}

fn default_obsidian_new_task_format() -> String {
    "auto".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ObsidianConfigPayload {
    vault_path: Option<String>,
    vault_name: String,
    #[serde(default = "default_obsidian_scan_folders")]
    scan_folders: Vec<String>,
    #[serde(default = "default_obsidian_inbox_file")]
    inbox_file: String,
    #[serde(default)]
    task_notes_include_archived: bool,
    #[serde(default)]
    dataview_metadata_enabled: bool,
    #[serde(default = "default_obsidian_new_task_format")]
    new_task_format: String,
    last_scanned_at: Option<String>,
    enabled: bool,
}

impl Default for ObsidianConfigPayload {
    fn default() -> Self {
        Self {
            vault_path: None,
            vault_name: String::new(),
            scan_folders: default_obsidian_scan_folders(),
            inbox_file: default_obsidian_inbox_file(),
            task_notes_include_archived: false,
            dataview_metadata_enabled: false,
            new_task_format: default_obsidian_new_task_format(),
            last_scanned_at: None,
            enabled: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ExternalCalendarSubscription {
    id: String,
    name: String,
    url: String,
    enabled: bool,
    color: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExternalCalendarEventRecord {
    id: String,
    source_id: String,
    title: String,
    start: String,
    end: String,
    all_day: bool,
    description: Option<String>,
    location: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MacOsCalendarReadResult {
    permission: String,
    calendars: Vec<ExternalCalendarSubscription>,
    events: Vec<ExternalCalendarEventRecord>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MacOsCalendarPushTarget {
    id: String,
    name: String,
    source_name: Option<String>,
    color: Option<String>,
    is_mindwtr_dedicated: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MacOsCalendarEventPayload {
    calendar_id: String,
    title: String,
    start: String,
    end: String,
    start_date: Option<String>,
    end_date: Option<String>,
    all_day: bool,
    notes: Option<String>,
    location: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct MacOsCalendarEventWriteResult {
    #[serde(default)]
    ok: bool,
    event_id: Option<String>,
    error: Option<String>,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn mindwtr_macos_calendar_permission_status_json() -> *mut c_char;
    fn mindwtr_macos_calendar_request_permission_json() -> *mut c_char;
    fn mindwtr_macos_calendar_events_json(
        range_start: *const c_char,
        range_end: *const c_char,
    ) -> *mut c_char;
    fn mindwtr_macos_writable_calendars_json() -> *mut c_char;
    fn mindwtr_macos_ensure_mindwtr_calendar_json(stored_calendar_id: *const c_char)
        -> *mut c_char;
    fn mindwtr_macos_create_calendar_event_json(event_json: *const c_char) -> *mut c_char;
    fn mindwtr_macos_update_calendar_event_json(
        event_id: *const c_char,
        event_json: *const c_char,
    ) -> *mut c_char;
    fn mindwtr_macos_delete_calendar_event_json(event_id: *const c_char) -> *mut c_char;
    fn mindwtr_macos_calendar_free_string(value: *mut c_char);
    fn mindwtr_macos_create_security_bookmark(path_cstr: *const c_char) -> *mut c_char;
    fn mindwtr_macos_resolve_security_bookmark(base64_cstr: *const c_char) -> *mut c_char;
    fn mindwtr_macos_free_bookmark_string(ptr: *mut c_char);
    fn mindwtr_macos_make_quick_add_panel(ns_window: *mut std::ffi::c_void) -> bool;
    fn mindwtr_macos_present_quick_add_panel(ns_window: *mut std::ffi::c_void) -> bool;

    fn mindwtr_cloudkit_account_status() -> *mut c_char;
    fn mindwtr_cloudkit_ensure_zone() -> *mut c_char;
    fn mindwtr_cloudkit_ensure_subscription() -> *mut c_char;
    fn mindwtr_cloudkit_fetch_all_records(record_type: *const c_char) -> *mut c_char;
    fn mindwtr_cloudkit_fetch_changes(change_token_base64: *const c_char) -> *mut c_char;
    fn mindwtr_cloudkit_save_records(
        record_type: *const c_char,
        records_json: *const c_char,
    ) -> *mut c_char;
    fn mindwtr_cloudkit_save_attachment_asset(
        record_name: *const c_char,
        file_path: *const c_char,
        metadata_json: *const c_char,
    ) -> *mut c_char;
    fn mindwtr_cloudkit_fetch_attachment_asset(
        record_name: *const c_char,
        target_path: *const c_char,
    ) -> *mut c_char;
    fn mindwtr_cloudkit_delete_records(
        record_type: *const c_char,
        record_ids_json: *const c_char,
    ) -> *mut c_char;
    fn mindwtr_cloudkit_register_for_remote_notifications();
    fn mindwtr_cloudkit_consume_pending_remote_change() -> i32;
    fn mindwtr_cloudkit_free_string(ptr: *mut c_char);
}

#[derive(Debug, Serialize, Deserialize)]
struct LinuxDistroInfo {
    id: Option<String>,
    id_like: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
struct DropboxTokenBundle {
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct DropboxTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error_description: Option<String>,
    error_summary: Option<String>,
}

struct QuickAddPending(Mutex<Option<String>>);
struct CloseRequestHandled(AtomicBool);
struct GlobalQuickAddShortcutState(Mutex<Option<String>>);

/// Windows only: macOS restores nothing because the quick-add panel never takes
/// activation away in the first place (#794).
#[derive(Clone, Copy, Debug, Default)]
struct QuickAddFocusSnapshot {
    windows_hwnd: Option<isize>,
}

#[derive(Default)]
struct QuickAddFocusState(Mutex<QuickAddFocusSnapshot>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GlobalQuickAddShortcutApplyResult {
    shortcut: String,
    warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickAddEventPayload {
    target: String,
}

fn default_global_quick_add_shortcut() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        GLOBAL_QUICK_ADD_SHORTCUT_DISABLED
    }
    #[cfg(not(target_os = "windows"))]
    {
        GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT
    }
}

fn launch_requests_quick_add<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|arg| arg.as_ref().eq_ignore_ascii_case(QUICK_ADD_CLI_FLAG))
}

fn launch_requests_startup<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|arg| arg.as_ref().eq_ignore_ascii_case(STARTUP_LAUNCH_CLI_FLAG))
}

#[cfg(any(target_os = "windows", test))]
fn with_windows_webview2_arguments(
    existing: Option<&str>,
    disable_hardware_acceleration: bool,
) -> String {
    let existing = existing.unwrap_or_default().trim();
    let mut passthrough: Vec<&str> = Vec::new();
    let mut disabled_features: Vec<&str> = Vec::new();
    for argument in existing.split_whitespace() {
        // Chromium keeps only the LAST --disable-features it is given, so a
        // caller's list and ours would silently cancel each other out. Merge
        // both into one flag instead (#913).
        if let Some(values) = argument.strip_prefix(WEBVIEW2_DISABLE_FEATURES_PREFIX) {
            for value in values.split(',').map(str::trim).filter(|v| !v.is_empty()) {
                if !disabled_features.contains(&value) {
                    disabled_features.push(value);
                }
            }
            continue;
        }
        passthrough.push(argument);
    }
    for value in WEBVIEW2_WRY_DEFAULT_DISABLED_FEATURES {
        if !disabled_features.contains(&value) {
            disabled_features.push(value);
        }
    }

    // Merged feature flag first, then the caller's other arguments, then ours:
    // a stable order keeps this idempotent when an already-built value is fed
    // back in (a user re-exporting the variable).
    let mut arguments: Vec<String> = vec![format!(
        "{WEBVIEW2_DISABLE_FEATURES_PREFIX}{}",
        disabled_features.join(",")
    )];
    arguments.extend(passthrough.iter().map(|value| (*value).to_string()));
    let mut appended = vec![WEBVIEW2_AUTOPLAY_ARG];
    appended.extend(WEBVIEW2_PHONE_HOME_ARGS);
    if disable_hardware_acceleration {
        appended.push(WEBVIEW2_DISABLE_GPU_ARG);
    }
    for argument in appended {
        if !passthrough.contains(&argument) {
            arguments.push(argument.to_string());
        }
    }

    arguments.join(" ")
}

fn bool_setting_enabled(value: Option<&str>) -> bool {
    value
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn hardware_acceleration_disabled(config: &AppConfigToml) -> bool {
    bool_setting_enabled(config.disable_hardware_acceleration.as_deref())
}

/// The main window starts hidden only when the process was launched by the
/// autostart entry AND a tray icon exists to bring the window back with.
/// A manual launch, or a launch with no tray to recover through, always
/// shows the window (#928).
fn should_start_hidden(launched_via_startup: bool, tray_icon_available: bool) -> bool {
    launched_via_startup && tray_icon_available
}

// Shared by the pre-window-build availability check and the real tray
// construction below, so both agree on whether a tray icon exists (#928).
fn resolve_tray_icon(handle: &tauri::AppHandle) -> Option<Image<'_>> {
    Image::from_bytes(include_bytes!("../icons/tray.png"))
        .ok()
        .or_else(|| handle.default_window_icon().cloned())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn read_startup_disable_hardware_acceleration() -> bool {
    let config = read_config_toml(&get_config_path_for_startup());
    hardware_acceleration_disabled(&config)
}

#[cfg(target_os = "windows")]
fn configure_windows_webview2_browser_arguments(disable_hardware_acceleration: bool) {
    // Keep these out of tauri.conf's `additionalBrowserArgs`: that config path
    // was the only Windows runtime change shared by rc.3/rc.4 in #913. WebView2
    // appends this environment value to Tauri's defaults, and the reporter
    // verified this path with the same switches without the IPC/close hang.
    let existing = env::var(WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS_ENV).ok();
    let arguments =
        with_windows_webview2_arguments(existing.as_deref(), disable_hardware_acceleration);
    env::set_var(WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS_ENV, arguments);
}

#[cfg(any(target_os = "linux", test))]
fn is_nvidia_vendor_id(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("0x10de")
}

#[cfg(target_os = "linux")]
fn linux_nvidia_gpu_detected() -> bool {
    linux_sysfs_has_nvidia_gpu(Path::new("/sys/class/drm"))
}

#[cfg(target_os = "linux")]
fn linux_sysfs_has_nvidia_gpu(root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    let mut any_nvidia = false;
    let mut saw_primary_marker = false;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if !file_name.starts_with("card") || file_name.contains('-') {
            continue;
        }
        let device_dir = entry.path().join("device");
        let vendor = fs::read_to_string(device_dir.join("vendor")).unwrap_or_default();
        let is_nvidia = is_nvidia_vendor_id(&vendor);
        any_nvidia |= is_nvidia;
        let boot_vga = fs::read_to_string(device_dir.join("boot_vga")).unwrap_or_default();
        let is_primary = boot_vga.trim() == "1";
        saw_primary_marker |= !boot_vga.trim().is_empty();
        if is_primary && is_nvidia {
            return true;
        }
    }
    !saw_primary_marker && any_nvidia
}

#[cfg(any(target_os = "linux", test))]
fn should_configure_linux_webkit_disable_dmabuf(
    existing_disable_dmabuf: Option<&str>,
    enable_dmabuf_override: Option<&str>,
    disable_hardware_acceleration: bool,
    detected_nvidia: bool,
) -> bool {
    existing_disable_dmabuf.is_none()
        && (disable_hardware_acceleration
            || (!bool_setting_enabled(enable_dmabuf_override) && detected_nvidia))
}

#[cfg(target_os = "linux")]
fn configure_linux_webkit_renderer(disable_hardware_acceleration: bool) {
    let existing_disable_dmabuf = env::var(WEBKIT_DISABLE_DMABUF_RENDERER_ENV).ok();
    let enable_dmabuf_override = env::var(MINDWTR_WEBKIT_ENABLE_DMABUF_ENV).ok();
    if should_configure_linux_webkit_disable_dmabuf(
        existing_disable_dmabuf.as_deref(),
        enable_dmabuf_override.as_deref(),
        disable_hardware_acceleration,
        linux_nvidia_gpu_detected(),
    ) {
        // WebKitGTK's DMABUF renderer can fail before a window appears on NVIDIA GBM setups.
        env::set_var(
            WEBKIT_DISABLE_DMABUF_RENDERER_ENV,
            WEBKIT_DISABLE_DMABUF_RENDERER_VALUE,
        );
    }
    if disable_hardware_acceleration && env::var(WEBKIT_DISABLE_COMPOSITING_MODE_ENV).is_err() {
        env::set_var(
            WEBKIT_DISABLE_COMPOSITING_MODE_ENV,
            WEBKIT_DISABLE_COMPOSITING_MODE_VALUE,
        );
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRenderingConfig {
    disable_hardware_acceleration: bool,
}

fn desktop_rendering_config_from(config: &AppConfigToml) -> DesktopRenderingConfig {
    DesktopRenderingConfig {
        disable_hardware_acceleration: hardware_acceleration_disabled(config),
    }
}

#[tauri::command(async)]
fn get_desktop_rendering_config(app: tauri::AppHandle) -> DesktopRenderingConfig {
    desktop_rendering_config_from(&read_config(&app))
}

// Held across the whole read+mutate+write (B2): read_config/write_config_files
// each only lock/unlock config.toml briefly on their own, so without this a
// concurrent config writer (e.g. write_local_api_config, clear_sync_path)
// could land between this read and write and lose its own change.
#[tauri::command(async)]
fn set_desktop_rendering_config(
    app: tauri::AppHandle,
    disable_hardware_acceleration: bool,
) -> Result<DesktopRenderingConfig, String> {
    let _config_guard = lock_config_read_modify_write()?;
    let mut config = read_config(&app);
    config.disable_hardware_acceleration = Some(
        if disable_hardware_acceleration {
            "true"
        } else {
            "false"
        }
        .to_string(),
    );
    let config_path = get_config_path(&app);
    let secrets_path = get_secrets_path(&app);
    write_config_files(&config_path, &secrets_path, &config)?;
    Ok(desktop_rendering_config_from(&config))
}

#[cfg(target_os = "linux")]
struct FlatpakInstanceListener {
    listener: UnixListener,
    socket_path: PathBuf,
}

#[cfg(target_os = "linux")]
struct FlatpakInstanceSocketCleanup(PathBuf);

#[cfg(target_os = "linux")]
impl Drop for FlatpakInstanceSocketCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(target_os = "linux")]
fn flatpak_runtime_dir() -> PathBuf {
    env::var_os("XDG_RUNTIME_DIR")
        .and_then(|value| {
            if value.as_os_str().is_empty() {
                None
            } else {
                Some(PathBuf::from(value))
            }
        })
        .unwrap_or_else(env::temp_dir)
}

#[cfg(target_os = "linux")]
fn flatpak_app_runtime_dir(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join(APP_NAME)
}

#[cfg(target_os = "linux")]
fn flatpak_instance_socket_path(runtime_dir: &Path) -> PathBuf {
    flatpak_app_runtime_dir(runtime_dir).join(FLATPAK_INSTANCE_SOCKET_FILE_NAME)
}

#[cfg(target_os = "linux")]
fn tray_icon_temp_dir(app_cache_dir: &Path) -> PathBuf {
    app_cache_dir.join(TRAY_ICON_DIR_NAME)
}

#[cfg(target_os = "linux")]
fn flatpak_instance_request<I, S>(args: I) -> &'static str
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    if launch_requests_quick_add(args) {
        FLATPAK_INSTANCE_REQUEST_QUICK_ADD
    } else {
        FLATPAK_INSTANCE_REQUEST_SHOW
    }
}

#[cfg(target_os = "linux")]
fn notify_existing_flatpak_instance(socket_path: &Path, args: &[String]) -> io::Result<()> {
    let mut stream = UnixStream::connect(socket_path)?;
    stream.write_all(flatpak_instance_request(args.iter()).as_bytes())?;
    stream.flush()
}

#[cfg(target_os = "linux")]
fn bind_flatpak_instance_listener(args: &[String]) -> io::Result<FlatpakInstanceListener> {
    let runtime_dir = flatpak_runtime_dir();
    let socket_path = flatpak_instance_socket_path(&runtime_dir);
    if let Some(parent) = socket_path.parent() {
        fs::create_dir_all(parent)?;
    }

    if socket_path.exists() {
        match notify_existing_flatpak_instance(&socket_path, args) {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                log::warn!("Removing stale Flatpak instance socket after notify failed: {error}");
                let _ = fs::remove_file(&socket_path);
            }
        }
    }

    match UnixListener::bind(&socket_path) {
        Ok(listener) => Ok(FlatpakInstanceListener {
            listener,
            socket_path,
        }),
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            if notify_existing_flatpak_instance(&socket_path, args).is_ok() {
                std::process::exit(0);
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn prepare_flatpak_instance_listener(args: &[String]) -> Option<FlatpakInstanceListener> {
    if !is_flatpak() {
        return None;
    }

    match bind_flatpak_instance_listener(args) {
        Ok(listener) => Some(listener),
        Err(error) => {
            log::warn!("Failed to prepare Flatpak single-instance fallback: {error}");
            None
        }
    }
}

#[cfg(target_os = "linux")]
fn handle_flatpak_instance_request(app: &tauri::AppHandle, request: &str) {
    if request.trim().eq_ignore_ascii_case("quick-add") {
        show_quick_add_window(app);
    } else {
        show_main(app);
    }
}

#[cfg(target_os = "linux")]
fn run_flatpak_instance_listener(app: tauri::AppHandle, listener: UnixListener) {
    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                let mut request = String::new();
                if let Err(error) = stream.read_to_string(&mut request) {
                    log::warn!("Failed to read Flatpak instance request: {error}");
                    continue;
                }
                handle_flatpak_instance_request(&app, &request);
            }
            Err(error) => {
                log::warn!("Flatpak instance listener stopped: {error}");
                break;
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn start_flatpak_instance_listener(
    app: &tauri::AppHandle,
    flatpak_instance_listener: FlatpakInstanceListener,
) {
    let FlatpakInstanceListener {
        listener,
        socket_path,
    } = flatpak_instance_listener;
    let app_for_thread = app.clone();
    let cleanup_path = socket_path.clone();

    match std::thread::Builder::new()
        .name("flatpak-instance-listener".to_string())
        .spawn(move || run_flatpak_instance_listener(app_for_thread, listener))
    {
        Ok(_) => {
            let _ = app.manage(FlatpakInstanceSocketCleanup(cleanup_path));
        }
        Err(error) => {
            log::warn!("Failed to start Flatpak instance listener: {error}");
            let _ = fs::remove_file(cleanup_path);
        }
    }
}

#[cfg(target_os = "linux")]
fn normalize_spellcheck_language(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_codeset = trimmed.split('.').next().unwrap_or(trimmed);
    let without_modifier = without_codeset
        .split('@')
        .next()
        .unwrap_or(without_codeset)
        .trim()
        .replace('-', "_");
    if without_modifier.is_empty()
        || without_modifier.eq_ignore_ascii_case("c")
        || without_modifier.eq_ignore_ascii_case("posix")
    {
        return None;
    }
    Some(without_modifier)
}

#[cfg(target_os = "linux")]
fn push_spellcheck_language(languages: &mut Vec<String>, language: String) {
    if !languages.iter().any(|existing| existing == &language) {
        languages.push(language);
    }
}

#[cfg(target_os = "linux")]
fn collect_spellcheck_languages(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut languages = Vec::new();
    for value in values {
        for raw_language in value.split(':') {
            let Some(language) = normalize_spellcheck_language(raw_language) else {
                continue;
            };
            push_spellcheck_language(&mut languages, language.clone());
            if let Some((base_language, _region)) = language.split_once('_') {
                push_spellcheck_language(&mut languages, base_language.to_string());
            }
        }
    }
    if languages.is_empty() {
        languages.push("en_US".to_string());
        languages.push("en".to_string());
    }
    languages
}

#[cfg(target_os = "linux")]
fn linux_spellcheck_languages() -> Vec<String> {
    collect_spellcheck_languages(
        ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]
            .into_iter()
            .filter_map(|key| env::var(key).ok()),
    )
}

#[cfg(target_os = "linux")]
fn enable_desktop_spellcheck(window: &tauri::WebviewWindow) {
    let languages = linux_spellcheck_languages();
    if let Err(error) = window.with_webview(move |webview| {
        use webkit2gtk::{WebContextExt, WebViewExt};

        let Some(context) = webview.inner().context() else {
            return;
        };
        let language_refs = languages.iter().map(String::as_str).collect::<Vec<_>>();
        context.set_spell_checking_languages(&language_refs);
        context.set_spell_checking_enabled(true);
    }) {
        log::warn!("Failed to enable WebKit spell checking: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
fn enable_desktop_spellcheck(_window: &tauri::WebviewWindow) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let disable_hardware_acceleration = read_startup_disable_hardware_acceleration();
    #[cfg(target_os = "windows")]
    configure_windows_webview2_browser_arguments(disable_hardware_acceleration);
    #[cfg(target_os = "linux")]
    configure_linux_webkit_renderer(disable_hardware_acceleration);

    let launch_args = env::args().collect::<Vec<_>>();
    let initial_launch_requests_quick_add = launch_requests_quick_add(launch_args.iter());
    let initial_launch_requests_startup = launch_requests_startup(launch_args.iter());
    #[cfg(target_os = "linux")]
    let flatpak_instance_listener = prepare_flatpak_instance_listener(&launch_args);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if launch_requests_quick_add(args.iter()) {
                show_quick_add_window(app);
            } else {
                show_main(app);
            }
        }))
        .manage(QuickAddPending(Mutex::new(None)))
        .manage(CloseRequestHandled(AtomicBool::new(false)))
        .manage(GlobalQuickAddShortcutState(Mutex::new(None)))
        .manage(QuickAddFocusState::default())
        .manage(MainWindowReveal::default())
        .manage(LocalApiServerState::default())
        .manage(DropboxStagedCredentialState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Mindwtr")
                .args([STARTUP_LAUNCH_CLI_FLAG])
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|handle| {
            let menu = Menu::default(handle)?;
            if let Some(help_submenu) = menu
                .get(HELP_SUBMENU_ID)
                .and_then(|item| item.as_submenu().cloned())
            {
                let docs_item = MenuItem::with_id(
                    handle,
                    MENU_HELP_DOCS_ID,
                    "Mindwtr Help",
                    true,
                    None::<&str>,
                )?;
                let issues_item = MenuItem::with_id(
                    handle,
                    MENU_HELP_ISSUES_ID,
                    "Report an Issue",
                    true,
                    None::<&str>,
                )?;
                help_submenu.append_items(&[&docs_item, &issues_item])?;
                let _ = help_submenu.set_as_help_menu_for_nsapp();
            }
            Ok(menu)
        })
        .on_menu_event(|_app, event| match event.id().as_ref() {
            MENU_HELP_DOCS_ID => {
                let _ = open::that("https://github.com/dongdongbh/Mindwtr#readme");
            }
            MENU_HELP_ISSUES_ID => {
                let _ = open::that("https://github.com/dongdongbh/Mindwtr/issues");
            }
            _ => {}
        });
    builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == QUICK_ADD_WINDOW_LABEL {
                    let _ = hide_quick_add_window_for_app(window.app_handle());
                    return;
                }
                append_native_log_line(
                    window.app_handle(),
                    "Close trace: native main-window close request received",
                );
                // Captured here as well as on exit: this is the last moment the
                // window is certainly on screen with the geometry the user left
                // it at, and a close-to-tray followed by a kill never reaches
                // RunEvent::Exit (#936).
                crate::window_state::save(window.app_handle());
                window
                    .app_handle()
                    .state::<CloseRequestHandled>()
                    .0
                    .store(false, Ordering::SeqCst);
                let emit_ok = window.emit("close-requested", ()).is_ok();
                append_native_log_line(
                    window.app_handle(),
                    if emit_ok {
                        "Close trace: native close-requested event emitted"
                    } else {
                        "Close trace: native close-requested event emission failed"
                    },
                );
                if !emit_ok {
                    let _ = window.set_skip_taskbar(true);
                    let _ = window.hide();
                } else {
                    let handle = window.app_handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(5));
                        if handle
                            .state::<CloseRequestHandled>()
                            .0
                            .load(Ordering::SeqCst)
                        {
                            return;
                        }
                        append_native_log_line(
                            &handle,
                            "Close trace: native close fallback timed out waiting for acknowledgement",
                        );
                        // #913: the app cannot close right now, which is exactly when
                        // the user must be able to see it and act on it. Hiding here
                        // used to turn a stuck save into a silent zombie process that
                        // still held the only copy of unsaved edits.
                        // Hopped onto the main thread (as
                        // reveal_main_window_after_timeout already does) so
                        // show_main's activation-policy switch is applied
                        // inline, before the window it reveals appears.
                        let reveal = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            if let Some(w) = reveal.get_webview_window("main") {
                                if !w.is_visible().unwrap_or(true) {
                                    // Through show_main so this forced reveal
                                    // also brings back the Dock icon and menu
                                    // bar a tray-hidden window gave up.
                                    show_main(&reveal);
                                }
                                let _ = w.set_focus();
                            }
                        });
                    });
                }
            }
        })
        .setup(move |app| {
            ensure_data_file(&app.handle()).ok();

            match recover_dropbox_credentials_on_startup(&app.handle()) {
                Ok(DropboxStartupRecoveryOutcome::Ready) => {}
                Ok(DropboxStartupRecoveryOutcome::SyncDisabled { warning }) => {
                    log::error!(
                        "Dropbox credential recovery required fail-closed containment: {warning}"
                    );
                }
                Err(error) => {
                    log::error!("Dropbox credential recovery could not be contained: {error}");
                    return Err(std::io::Error::new(std::io::ErrorKind::Other, error).into());
                }
            }

            let config = read_config(&app.handle());
            // One-time fixup for autostart entries that predate the --startup
            // flag, so should_start_hidden below can actually trigger for
            // installs that already had Launch at startup on (#928).
            autostart::migrate_autostart_entry_if_pending(&app.handle());
            // Resolved before the window is built: whether a tray icon can
            // even be created decides whether it's safe to build the window
            // hidden (#928) — see should_start_hidden below.
            let tray_icon_available = resolve_tray_icon(&app.handle()).is_some();
            let start_hidden =
                should_start_hidden(initial_launch_requests_startup, tray_icon_available);
            if start_hidden || initial_launch_requests_quick_add {
                // Nothing to reveal: the autostart entry launched us with "start
                // in tray" on and a tray icon to recover through (#928), or the
                // global hotkey wants only the quick-add window. If tray
                // construction fails further down despite the icon being
                // available, that branch forces the window back.
                app.state::<MainWindowReveal>().suppress();
            }
            if start_hidden {
                // Launched straight into the tray, so there is no window to
                // own a Dock icon or the menu bar yet. show_main restores
                // Regular on whichever path brings the window up. A quick-add
                // launch is deliberately not included: that one does put a
                // window on screen.
                let _ = crate::platform::apply_macos_activation_policy(&app.handle(), true);
            }

            // The main window is declared create:false so portable mode can pin
            // the webview's browsing profile inside the portable dir (#855).
            {
                let main_window_config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|window| window.label == "main")
                    .cloned()
                    .ok_or("main window config missing")?;
                let mut main_window_builder =
                    tauri::WebviewWindowBuilder::from_config(app.handle(), &main_window_config)?;
                if let Some(webview_dir) = crate::storage::portable_webview_data_dir() {
                    let _ = std::fs::create_dir_all(&webview_dir);
                    main_window_builder = main_window_builder.data_directory(webview_dir);
                }
                // Always built hidden, and revealed only once the webview has
                // painted (notify_ui_ready, with reveal_main_window_after_timeout
                // as the backstop). The window-state plugin restores geometry
                // from its own on_window_ready, which Tauri dispatches through
                // run_on_main_thread — so it only lands once the event loop is
                // pumping, and a window built visible sits on screen at the
                // config's 1200x800, blank, until then and then jumps (#936).
                // Restoring here keeps all of that off screen.
                main_window_builder = main_window_builder.visible(false);
                let main_window = main_window_builder.build()?;
                crate::window_state::restore(&main_window);
                reveal_main_window_after_timeout(&app.handle());
            }

            // Portable mode stores webview-managed files (attachments, logs,
            // captures) under the profile dir, which lies outside the fs
            // plugin's static $DATA scope.
            if crate::storage::is_portable_mode() {
                expand_tauri_fs_scope(&app.handle(), &get_data_dir(&app.handle()));
            }

            {
                #[cfg(target_os = "macos")]
                if let Some(ref bookmark) = config.sync_path_bookmark {
                    if let Some(resolved) = resolve_sync_path_bookmark(bookmark) {
                        expand_tauri_fs_scope(&app.handle(), &resolved);
                    }
                }

                if let Some(ref sp) = config.sync_path {
                    let p = PathBuf::from(sp);
                    if p.exists() {
                        expand_tauri_fs_scope(&app.handle(), &p);
                    }
                }

                // Also expand scope for the Obsidian vault path, which may be
                // inside iCloud Drive or another location not covered at runtime.
                if let Some(ref raw_obsidian) = config.obsidian_config {
                    #[derive(serde::Deserialize, Default)]
                    struct VaultPathOnly {
                        vault_path: Option<String>,
                    }
                    if let Ok(parsed) = serde_json::from_str::<VaultPathOnly>(raw_obsidian) {
                        if let Some(vp) = parsed.vault_path {
                            let p = PathBuf::from(vp.trim());
                            if p.exists() {
                                expand_tauri_fs_scope(&app.handle(), &p);
                            }
                        }
                    }
                }
            }

            let diagnostics_enabled = diagnostics_enabled();
            let is_flatpak_install = cfg!(target_os = "linux") && is_flatpak();
            if let Some(window) = app.get_webview_window("main") {
                enable_desktop_spellcheck(&window);
                #[cfg(target_os = "linux")]
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    let _ = window.set_icon(icon);
                }
                if cfg!(target_os = "linux") && is_niri_session() {
                    let _ = window.set_decorations(false);
                }
                if diagnostics_enabled {
                    let _ = window.eval("window.__MINDWTR_DIAGNOSTICS__ = true;");
                    #[cfg(any(debug_assertions, feature = "diagnostics"))]
                    {
                        let _ = window.open_devtools();
                    }
                }
                if is_flatpak_install {
                    let _ = window.eval("window.__MINDWTR_FLATPAK__ = true;");
                }
            }

            let handle = app.handle();
            #[cfg(target_os = "linux")]
            if let Some(listener) = flatpak_instance_listener {
                start_flatpak_instance_listener(&handle, listener);
            }
            if let Err(error) = create_quick_add_window(&handle) {
                log::warn!("{error}");
            }
            let tray_init_result: tauri::Result<()> = (|| {
                let quick_add_item =
                    MenuItem::with_id(handle, "quick_add", "Quick Add", true, None::<&str>)?;
                let show_item =
                    MenuItem::with_id(handle, "show", "Show Mindwtr", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(handle, "quit", "Quit", true, None::<&str>)?;
                let tray_menu =
                    Menu::with_items(handle, &[&quick_add_item, &show_item, &quit_item])?;

                let tray_icon = resolve_tray_icon(handle);

                if let Some(tray_icon) = tray_icon {
                    let mut tray_builder = TrayIconBuilder::with_id("main")
                        .icon(tray_icon)
                        .menu(&tray_menu)
                        .show_menu_on_left_click(false);
                    // The tray protocol hands the panel a PATH to the icon,
                    // so the file must stay readable for the whole session.
                    // The default temp dir breaks that in two ways: Flatpak's
                    // /tmp is invisible to the host panel (the original reason
                    // for this redirect), and on regular installs /tmp is
                    // subject to cleaners and sandboxed launchers that mount a
                    // private /tmp — a panel that re-resolves the icon later
                    // then draws a blank slot (#1018, Cinnamon AppImage). The
                    // app cache dir is user-owned, host-visible, and stable.
                    #[cfg(target_os = "linux")]
                    {
                        match handle.path().app_cache_dir() {
                            Ok(app_cache_dir) => {
                                let tray_icon_temp_dir = tray_icon_temp_dir(&app_cache_dir);
                                if let Err(error) = fs::create_dir_all(&tray_icon_temp_dir) {
                                    log::warn!(
                                        "Failed to prepare tray icon directory: {error}"
                                    );
                                } else {
                                    tray_builder = tray_builder.temp_dir_path(tray_icon_temp_dir);
                                }
                            }
                            Err(error) => {
                                log::warn!(
                                    "Failed to resolve tray icon cache directory: {error}"
                                );
                            }
                        }
                    }
                    let _ = tray_builder
                        .on_menu_event(move |app, event| match event.id().as_ref() {
                            "quick_add" => {
                                show_quick_add_window(app);
                            }
                            "show" => {
                                show_main(app);
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        })
                        .on_tray_icon_event(|tray, event| {
                            if let TrayIconEvent::Click {
                                button,
                                button_state,
                                ..
                            } = event
                            {
                                if button == MouseButton::Left
                                    && button_state == MouseButtonState::Up
                                {
                                    show_main(tray.app_handle());
                                }
                            }
                        })
                        .build(handle)?;
                } else {
                    log::warn!("No tray icon available; skipping tray initialization.");
                }

                Ok(())
            })();

            if let Err(error) = tray_init_result {
                log::warn!("Failed to initialize tray support: {error}");
                if start_hidden {
                    // The icon decoded fine but tray construction itself
                    // errored (menu items, tray builder) — never leave a
                    // hidden window with no tray to recover it through (#928,
                    // the failure mode #913 was about). Bypasses the reveal
                    // gate deliberately: it was suppressed for a tray start
                    // that no longer has a tray.
                    show_main(&handle);
                }
            }

            let shortcut_state = app.state::<GlobalQuickAddShortcutState>();
            let default_shortcut = if is_flatpak_install {
                GLOBAL_QUICK_ADD_SHORTCUT_DISABLED
            } else {
                default_global_quick_add_shortcut()
            };
            if let Err(error) =
                apply_global_quick_add_shortcut(&handle, &shortcut_state, Some(default_shortcut))
            {
                log::warn!("Failed to register global quick add shortcut: {error}");
            }

            if initial_launch_requests_quick_add {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_skip_taskbar(true);
                    let _ = window.hide();
                }
                show_quick_add_window(&handle);
            }

            {
                let local_api_state = app.state::<LocalApiServerState>();
                start_configured_local_api_server(&handle, &local_api_state);
            }

            if cfg!(debug_assertions) || diagnostics_enabled {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .manage(AudioRecorderState::default())
        .manage(ObsidianWatcherState::default())
        .invoke_handler(tauri::generate_handler![
            notify_ui_ready,
            check_microsoft_store_update,
            get_data,
            read_data_json,
            save_data,
            save_task,
            create_data_snapshot,
            list_data_snapshots,
            restore_data_snapshot,
            query_tasks,
            search_fts,
            get_data_path_cmd,
            get_db_path_cmd,
            acknowledge_close_request,
            get_ai_key,
            set_ai_key,
            get_sync_path,
            clear_sync_path,
            set_sync_path,
            get_sync_backend,
            get_sync_cloud_provider,
            get_sync_cloud_provider_state,
            get_sync_configuration_snapshot,
            set_sync_backend,
            set_sync_cloud_provider,
            get_obsidian_config,
            set_obsidian_config,
            expand_obsidian_vault_scope,
            check_obsidian_vault_marker,
            list_obsidian_vaults,
            start_obsidian_watcher,
            stop_obsidian_watcher,
            obsidian_toggle_task,
            obsidian_toggle_tasknotes,
            obsidian_create_task,
            obsidian_create_tasknotes,
            get_webdav_config,
            get_webdav_password,
            set_webdav_config,
            webdav_get_json,
            webdav_put_json,
            get_cloud_config,
            set_cloud_config,
            set_network_proxy,
            cloud_get_json,
            cloud_put_json,
            get_dropbox_redirect_uri,
            is_dropbox_connected,
            connect_dropbox,
            get_dropbox_access_token,
            promote_staged_dropbox_credentials,
            recover_dropbox_credentials_before_sync_configuration,
            rollback_staged_dropbox_credentials,
            finalize_staged_dropbox_credentials,
            discard_staged_dropbox_credentials,
            disconnect_dropbox,
            get_external_calendars,
            set_external_calendars,
            read_external_calendar_file,
            get_macos_calendar_permission_status,
            request_macos_calendar_permission,
            get_macos_calendar_events,
            get_macos_writable_calendars,
            ensure_macos_mindwtr_calendar,
            create_macos_calendar_event,
            update_macos_calendar_event,
            delete_macos_calendar_event,
            get_linux_calendar_permission_status,
            request_linux_calendar_permission,
            get_linux_calendar_events,
            get_linux_writable_calendars,
            ensure_linux_mindwtr_calendar,
            create_linux_calendar_event,
            update_linux_calendar_event,
            delete_linux_calendar_event,
            get_calendar_sync_entry,
            upsert_calendar_sync_entry,
            delete_calendar_sync_entry,
            get_all_calendar_sync_entries,
            cloudkit_account_status,
            cloudkit_ensure_zone,
            cloudkit_ensure_subscription,
            cloudkit_fetch_all_records,
            cloudkit_fetch_changes,
            cloudkit_fetch_attachment_asset,
            cloudkit_save_attachment_asset,
            cloudkit_save_records,
            cloudkit_delete_records,
            cloudkit_consume_pending_remote_change,
            cloudkit_register_for_notifications,
            get_managed_data_dir,
            import_attachment_file,
            migrate_portable_attachments,
            open_path,
            read_sync_file,
            read_sync_file_versioned,
            write_sync_file,
            sync_fs_exists,
            sync_fs_create_dir,
            sync_fs_remove_file,
            sync_fs_rename,
            set_tray_visible,
            set_tray_tooltip,
            set_macos_activation_policy,
            get_linux_distro,
            start_audio_recording,
            stop_audio_recording,
            transcribe_whisper,
            transcribe_parakeet,
            download_parakeet_model,
            download_whisper_model,
            append_log_line,
            clear_log_file,
            consume_quick_add_pending,
            get_system_theme_preference,
            set_global_quick_add_shortcut,
            hide_quick_add_window,
            get_install_source,
            get_launch_at_startup_enabled,
            set_launch_at_startup_enabled,
            send_flatpak_notification,
            get_local_api_server_status,
            set_local_api_server_config,
            get_email_capture_config,
            set_email_capture_config,
            email_capture_poll,
            email_capture_commit,
            get_desktop_rendering_config,
            set_desktop_rendering_config,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                crate::window_state::save(app);
                // Other plugins can still create the OS config dir a portable
                // install is meant to stay out of; clearing it here runs after
                // they have handled the same event (#936).
                crate::storage::cleanup_portable_os_config_dir(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("mindwtr-{name}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn write_config_files_stores_dropbox_tokens_in_secrets_file() {
        let dir = unique_test_dir("dropbox-tokens");
        fs::create_dir_all(&dir).expect("should create temp config dir");

        let config_path = dir.join("config.toml");
        let secrets_path = dir.join("secrets.toml");
        let tokens = DropboxTokenBundle {
            client_id: "client-id".to_string(),
            access_token: "access-token".to_string(),
            refresh_token: "refresh-token".to_string(),
            expires_at: 1_763_683_200,
        };
        let payload = serde_json::to_string(&tokens).expect("should serialize Dropbox tokens");
        let config = AppConfigToml {
            sync_backend: Some("dropbox".to_string()),
            dropbox_tokens: Some(payload.clone()),
            ..AppConfigToml::default()
        };

        write_config_files(&config_path, &secrets_path, &config)
            .expect("should write config and secrets files");

        let public_config = read_config_toml(&config_path);
        let secrets_config = read_config_toml(&secrets_path);

        assert_eq!(public_config.sync_backend.as_deref(), Some("dropbox"));
        assert_eq!(public_config.dropbox_tokens, None);
        assert_eq!(secrets_config.dropbox_tokens, Some(payload));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sync_configuration_transaction_commands_are_registered() {
        let source = include_str!("lib.rs");
        let handler = source
            .split_once("tauri::generate_handler![")
            .and_then(|(_, rest)| rest.split_once("])").map(|(commands, _)| commands))
            .expect("Tauri command handler should be present");

        assert!(handler.contains("get_sync_configuration_snapshot,"));
        assert!(handler.contains("get_sync_cloud_provider,"));
        assert!(handler.contains("get_sync_cloud_provider_state,"));
        assert!(handler.contains("set_sync_cloud_provider,"));
        assert!(handler.contains("clear_sync_path,"));
        assert!(handler.contains("promote_staged_dropbox_credentials,"));
        assert!(handler.contains("recover_dropbox_credentials_before_sync_configuration,"));
        assert!(handler.contains("rollback_staged_dropbox_credentials,"));
        assert!(handler.contains("finalize_staged_dropbox_credentials,"));
        assert!(handler.contains("discard_staged_dropbox_credentials,"));
        assert!(source.contains(".manage(DropboxStagedCredentialState::default())"));
    }

    #[test]
    fn hardware_acceleration_setting_round_trips_in_public_config() {
        let dir = unique_test_dir("hardware-acceleration");
        fs::create_dir_all(&dir).expect("should create temp config dir");

        let config_path = dir.join("config.toml");
        let secrets_path = dir.join("secrets.toml");
        let config = AppConfigToml {
            disable_hardware_acceleration: Some("true".to_string()),
            ..AppConfigToml::default()
        };

        write_config_files(&config_path, &secrets_path, &config)
            .expect("should write config files");

        let public_config = read_config_toml(&config_path);
        assert_eq!(
            public_config.disable_hardware_acceleration.as_deref(),
            Some("true")
        );
        assert!(hardware_acceleration_disabled(&public_config));
        assert!(!secrets_path.exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn launch_requests_startup_matches_flag() {
        assert!(launch_requests_startup(["mindwtr", "--startup"]));
        assert!(launch_requests_startup(["mindwtr", "--STARTUP"]));
        assert!(!launch_requests_startup(["mindwtr"]));
        assert!(!launch_requests_startup(["mindwtr", "--quick-add"]));
        // Mixed with other flags, order doesn't matter.
        assert!(launch_requests_startup(["mindwtr", "--foo", "--startup"]));
    }

    #[test]
    fn should_start_hidden_requires_both_conditions() {
        assert!(should_start_hidden(true, true));
        assert!(!should_start_hidden(false, true));
        assert!(!should_start_hidden(true, false));
        assert!(!should_start_hidden(false, false));
    }

    #[test]
    fn flatpak_install_channel_reads_branch_from_instance_section() {
        let contents = r#"
[Application]
name=tech.dongdongbh.mindwtr

[Instance]
instance-id=123456
branch=stable
arch=x86_64
"#;

        assert_eq!(
            parse_flatpak_install_channel(contents).as_deref(),
            Some("stable")
        );
    }

    #[test]
    fn launch_requests_quick_add_matches_flag() {
        assert!(launch_requests_quick_add(["mindwtr", "--quick-add"]));
        assert!(launch_requests_quick_add(["mindwtr", "--QUICK-ADD"]));
        assert!(!launch_requests_quick_add(["mindwtr"]));
        assert!(!launch_requests_quick_add(["mindwtr", "--foo"]));
    }

    #[test]
    fn webview2_browser_arguments_carry_wry_defaults_and_preserve_existing_values() {
        const DEFAULTS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--autoplay-policy=no-user-gesture-required --disable-component-update \
--disable-domain-reliability --no-pings";

        // wry only passes its own defaults while the app supplies no arguments;
        // this environment value can replace them, so it must carry them (#913).
        assert_eq!(with_windows_webview2_arguments(None, false), DEFAULTS);
        assert_eq!(
            with_windows_webview2_arguments(Some("--foo=bar"), false),
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --foo=bar \
--autoplay-policy=no-user-gesture-required --disable-component-update \
--disable-domain-reliability --no-pings",
        );
        // Switches the caller already set are never duplicated.
        assert_eq!(
            with_windows_webview2_arguments(Some("--disable-component-update"), true),
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--disable-component-update --autoplay-policy=no-user-gesture-required \
--disable-domain-reliability --no-pings --disable-gpu",
        );
        // A caller's own --disable-features must survive: Chromium keeps only
        // the last one, so the two lists are merged instead of overwriting.
        assert_eq!(
            with_windows_webview2_arguments(Some("--disable-features=Translate"), false),
            "--disable-features=Translate,msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--autoplay-policy=no-user-gesture-required --disable-component-update \
--disable-domain-reliability --no-pings",
        );
        // Idempotent: re-exporting a value we already built changes nothing.
        assert_eq!(
            with_windows_webview2_arguments(Some(DEFAULTS), false),
            DEFAULTS
        );
    }

    #[test]
    fn linux_webkit_dmabuf_renderer_is_targeted_to_nvidia_or_local_setting() {
        assert!(!should_configure_linux_webkit_disable_dmabuf(
            None, None, false, false,
        ));
        assert!(should_configure_linux_webkit_disable_dmabuf(
            None, None, false, true,
        ));
        assert!(!should_configure_linux_webkit_disable_dmabuf(
            None,
            Some("1"),
            false,
            true,
        ));
        assert!(should_configure_linux_webkit_disable_dmabuf(
            None,
            Some("1"),
            true,
            true,
        ));
        assert!(!should_configure_linux_webkit_disable_dmabuf(
            Some("0"),
            None,
            true,
            true,
        ));
    }

    #[test]
    fn nvidia_vendor_id_matches_sysfs_value() {
        assert!(is_nvidia_vendor_id("0x10de\n"));
        assert!(is_nvidia_vendor_id("0X10DE"));
        assert!(!is_nvidia_vendor_id("0x8086"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn flatpak_instance_request_preserves_quick_add_launches() {
        assert_eq!(
            flatpak_instance_request(["mindwtr", "--quick-add"]),
            FLATPAK_INSTANCE_REQUEST_QUICK_ADD
        );
        assert_eq!(
            flatpak_instance_request(["mindwtr"]),
            FLATPAK_INSTANCE_REQUEST_SHOW
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn flatpak_runtime_paths_are_app_scoped() {
        let runtime_dir = Path::new("/run/user/1000");

        assert_eq!(
            flatpak_instance_socket_path(runtime_dir),
            PathBuf::from("/run/user/1000/mindwtr/instance.sock")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn tray_icon_path_uses_app_cache_dir() {
        let app_cache_dir = Path::new("/home/user/.var/app/tech.dongdongbh.mindwtr/cache");

        assert_eq!(
            tray_icon_temp_dir(app_cache_dir),
            PathBuf::from("/home/user/.var/app/tech.dongdongbh.mindwtr/cache/tray-icon")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn collect_spellcheck_languages_normalizes_locale_values() {
        assert_eq!(
            collect_spellcheck_languages([
                "en_US.UTF-8".to_string(),
                "de-DE:fr_CA@euro".to_string(),
                "C".to_string(),
            ]),
            vec!["en_US", "en", "de_DE", "de", "fr_CA", "fr"]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn collect_spellcheck_languages_falls_back_to_english() {
        assert_eq!(
            collect_spellcheck_languages(["C.UTF-8".to_string(), "POSIX".to_string()]),
            vec!["en_US", "en"]
        );
    }
}
