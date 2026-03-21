use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use keyring::{Entry, Error as KeyringError};
use rand::RngCore;
use reqwest::StatusCode;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, ToSql};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::net::TcpListener;
#[cfg(target_os = "macos")]
use std::os::raw::c_char;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::image::Image;
#[cfg(target_os = "macos")]
use tauri::menu::HELP_SUBMENU_ID;
use tauri::menu::{Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_fs::FsExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use time::OffsetDateTime;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// App name used for config directories and files
const APP_NAME: &str = "mindwtr";
const CONFIG_FILE_NAME: &str = "config.toml";
const SECRETS_FILE_NAME: &str = "secrets.toml";
const DATA_FILE_NAME: &str = "data.json";
const DB_FILE_NAME: &str = "mindwtr.db";
const SNAPSHOT_DIR_NAME: &str = "snapshots";
const SNAPSHOT_RETENTION_MAX_COUNT: usize = 5;
const SNAPSHOT_RETENTION_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;
const SNAPSHOT_RETENTION_RECENT_COUNT: usize = 2;
const SQLITE_BUSY_TIMEOUT_MS: u64 = 5_000;
const STORAGE_RETRY_ATTEMPTS: usize = 4;
const STORAGE_RETRY_BASE_DELAY_MS: u64 = 120;
const KEYRING_WEB_DAV_PASSWORD: &str = "webdav_password";
const KEYRING_CLOUD_TOKEN: &str = "cloud_token";
const KEYRING_DROPBOX_TOKENS: &str = "dropbox_tokens";
const KEYRING_AI_OPENAI: &str = "ai_key_openai";
const KEYRING_AI_ANTHROPIC: &str = "ai_key_anthropic";
const KEYRING_AI_GEMINI: &str = "ai_key_gemini";
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
const GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT: &str = "Control+Alt+M";
const GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N: &str = "Control+Alt+N";
const GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q: &str = "Control+Alt+Q";
const GLOBAL_QUICK_ADD_SHORTCUT_LEGACY: &str = "CommandOrControl+Shift+A";
const GLOBAL_QUICK_ADD_SHORTCUT_DISABLED: &str = "disabled";
#[cfg(target_os = "macos")]
const MENU_HELP_DOCS_ID: &str = "help_docs";
#[cfg(target_os = "macos")]
const MENU_HELP_ISSUES_ID: &str = "help_report_issue";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const SQLITE_SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT,
  taskMode TEXT,
  startTime TEXT,
  dueDate TEXT,
  recurrence TEXT,
  pushCount INTEGER,
  tags TEXT,
  contexts TEXT,
  checklist TEXT,
  description TEXT,
  attachments TEXT,
  location TEXT,
  projectId TEXT,
  sectionId TEXT,
  areaId TEXT,
  orderNum INTEGER,
  isFocusedToday INTEGER,
  timeEstimate TEXT,
  reviewAt TEXT,
  completedAt TEXT,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT,
  purgedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(projectId);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updatedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks(deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(dueDate);
CREATE INDEX IF NOT EXISTS idx_tasks_start_time ON tasks(startTime);
CREATE INDEX IF NOT EXISTS idx_tasks_review_at ON tasks(reviewAt);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(createdAt);
CREATE INDEX IF NOT EXISTS idx_tasks_status_deleted_at ON tasks(status, deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status_deleted_at ON tasks(projectId, status, deletedAt);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  color TEXT NOT NULL,
  orderNum INTEGER,
  tagIds TEXT,
  isSequential INTEGER,
  isFocused INTEGER,
  supportNotes TEXT,
  attachments TEXT,
  reviewAt TEXT,
  areaId TEXT,
  areaTitle TEXT,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);

CREATE TABLE IF NOT EXISTS areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  orderNum INTEGER NOT NULL,
  deletedAt TEXT,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  orderNum INTEGER,
  isCollapsed INTEGER,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);

CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  id UNINDEXED,
  title,
  description,
  tags,
  contexts,
  content=''
);

CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
  id UNINDEXED,
  title,
  supportNotes,
  tagIds,
  areaTitle,
  content=''
);

CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts (id, title, description, tags, contexts)
  VALUES (new.id, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''));
END;

CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts (tasks_fts, id, title, description, tags, contexts)
  VALUES ('delete', old.id, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''));
END;

CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts (tasks_fts, id, title, description, tags, contexts)
  VALUES ('delete', old.id, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''));
  INSERT INTO tasks_fts (id, title, description, tags, contexts)
  VALUES (new.id, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
  INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
  VALUES (new.id, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
  INSERT INTO projects_fts (projects_fts, id, title, supportNotes, tagIds, areaTitle)
  VALUES ('delete', old.id, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
  INSERT INTO projects_fts (projects_fts, id, title, supportNotes, tagIds, areaTitle)
  VALUES ('delete', old.id, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
  INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
  VALUES (new.id, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
END;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_projectId ON tasks(projectId);
CREATE INDEX IF NOT EXISTS idx_tasks_deletedAt ON tasks(deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_dueDate ON tasks(dueDate);
CREATE INDEX IF NOT EXISTS idx_tasks_startTime ON tasks(startTime);
CREATE INDEX IF NOT EXISTS idx_tasks_reviewAt ON tasks(reviewAt);
CREATE INDEX IF NOT EXISTS idx_tasks_createdAt ON tasks(createdAt);
CREATE INDEX IF NOT EXISTS idx_tasks_updatedAt ON tasks(updatedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_status_deletedAt ON tasks(status, deletedAt);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status_deletedAt ON tasks(projectId, status, deletedAt);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_areaId ON projects(areaId);
"#;

#[derive(Debug, Serialize, Deserialize, Default)]
struct LegacyAppConfigJson {
    data_file_path: Option<String>,
    sync_path: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct AppConfigToml {
    sync_path: Option<String>,
    sync_path_bookmark: Option<String>,
    sync_backend: Option<String>,
    webdav_url: Option<String>,
    webdav_username: Option<String>,
    webdav_password: Option<String>,
    cloud_url: Option<String>,
    cloud_token: Option<String>,
    dropbox_tokens: Option<String>,
    obsidian_config: Option<String>,
    external_calendars: Option<String>,
    ai_key_openai: Option<String>,
    ai_key_anthropic: Option<String>,
    ai_key_gemini: Option<String>,
}

fn default_obsidian_scan_folders() -> Vec<String> {
    vec!["/".to_string()]
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ObsidianConfigPayload {
    vault_path: Option<String>,
    vault_name: String,
    #[serde(default = "default_obsidian_scan_folders")]
    scan_folders: Vec<String>,
    last_scanned_at: Option<String>,
    enabled: bool,
}

impl Default for ObsidianConfigPayload {
    fn default() -> Self {
        Self {
            vault_path: None,
            vault_name: String::new(),
            scan_folders: default_obsidian_scan_folders(),
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

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn mindwtr_macos_calendar_permission_status_json() -> *mut c_char;
    fn mindwtr_macos_calendar_request_permission_json() -> *mut c_char;
    fn mindwtr_macos_calendar_events_json(
        range_start: *const c_char,
        range_end: *const c_char,
    ) -> *mut c_char;
    fn mindwtr_macos_calendar_free_string(value: *mut c_char);
    fn mindwtr_macos_create_security_bookmark(path_cstr: *const c_char) -> *mut c_char;
    fn mindwtr_macos_resolve_security_bookmark(base64_cstr: *const c_char) -> *mut c_char;
    fn mindwtr_macos_free_bookmark_string(ptr: *mut c_char);

    // CloudKit bridge
    fn mindwtr_cloudkit_account_status() -> *mut c_char;
    fn mindwtr_cloudkit_ensure_zone() -> *mut c_char;
    fn mindwtr_cloudkit_ensure_subscription() -> *mut c_char;
    fn mindwtr_cloudkit_fetch_all_records(record_type: *const c_char) -> *mut c_char;
    fn mindwtr_cloudkit_fetch_changes(change_token_base64: *const c_char) -> *mut c_char;
    fn mindwtr_cloudkit_save_records(record_type: *const c_char, records_json: *const c_char) -> *mut c_char;
    fn mindwtr_cloudkit_delete_records(record_type: *const c_char, record_ids_json: *const c_char) -> *mut c_char;
    fn mindwtr_cloudkit_register_for_remote_notifications();
    fn mindwtr_cloudkit_consume_pending_remote_change() -> i32;
    fn mindwtr_cloudkit_free_string(ptr: *mut c_char);
}

#[derive(Debug, Serialize, Deserialize)]
struct LinuxDistroInfo {
    id: Option<String>,
    id_like: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskQueryOptions {
    status: Option<String>,
    project_id: Option<String>,
    exclude_statuses: Option<Vec<String>>,
    include_deleted: Option<bool>,
    include_archived: Option<bool>,
}

struct QuickAddPending(AtomicBool);
struct CloseRequestHandled(AtomicBool);
struct GlobalQuickAddShortcutState(Mutex<Option<String>>);

struct AudioRecorderState(Mutex<Option<AudioRecorderHandle>>);

#[derive(Clone, Debug)]
struct RecorderInfo {
    sample_rate: u32,
    channels: u16,
}

struct AudioRecorderHandle {
    stop_tx: mpsc::Sender<()>,
    samples: Arc<Mutex<Vec<i16>>>,
    info: Arc<Mutex<Option<RecorderInfo>>>,
    join: Option<std::thread::JoinHandle<()>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioCaptureResult {
    path: String,
    relative_path: String,
    sample_rate: u32,
    channels: u16,
    size: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GlobalQuickAddShortcutApplyResult {
    shortcut: String,
    warning: Option<String>,
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

#[tauri::command]
fn consume_quick_add_pending(state: tauri::State<'_, QuickAddPending>) -> bool {
    state.0.swap(false, Ordering::SeqCst)
}

#[tauri::command]
fn acknowledge_close_request(state: tauri::State<'_, CloseRequestHandled>) {
    state.0.store(true, Ordering::SeqCst);
}

fn normalize_global_quick_add_shortcut(shortcut: Option<&str>) -> Result<Option<String>, String> {
    let trimmed = shortcut.map(str::trim).unwrap_or("");
    if trimmed.is_empty() {
        return Ok(Some(default_global_quick_add_shortcut().to_string()));
    }

    if trimmed.eq_ignore_ascii_case(GLOBAL_QUICK_ADD_SHORTCUT_DISABLED) {
        return Ok(None);
    }

    if trimmed == GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT
        || trimmed == GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N
        || trimmed == GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q
        || trimmed == GLOBAL_QUICK_ADD_SHORTCUT_LEGACY
    {
        return Ok(Some(trimmed.to_string()));
    }

    Err("Unsupported quick add shortcut".to_string())
}

fn apply_global_quick_add_shortcut(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, GlobalQuickAddShortcutState>,
    shortcut: Option<&str>,
) -> Result<String, String> {
    let normalized = normalize_global_quick_add_shortcut(shortcut)?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Shortcut state lock poisoned".to_string())?;

    if *guard == normalized {
        return Ok(guard
            .clone()
            .unwrap_or_else(|| GLOBAL_QUICK_ADD_SHORTCUT_DISABLED.to_string()));
    }

    if let Some(existing) = guard.as_ref() {
        if let Err(error) = app.global_shortcut().unregister(existing.as_str()) {
            log::warn!("Failed to unregister existing quick add shortcut: {error}");
        }
    }

    if let Some(next_shortcut) = normalized.as_ref() {
        app.global_shortcut()
            .on_shortcut(next_shortcut.as_str(), move |app, _shortcut, _event| {
                show_main_and_emit(app);
            })
            .map_err(|error| format!("Failed to register global quick add shortcut: {error}"))?;
    }

    *guard = normalized.clone();
    Ok(normalized.unwrap_or_else(|| GLOBAL_QUICK_ADD_SHORTCUT_DISABLED.to_string()))
}

#[tauri::command]
fn set_global_quick_add_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, GlobalQuickAddShortcutState>,
    shortcut: Option<String>,
) -> Result<GlobalQuickAddShortcutApplyResult, String> {
    match apply_global_quick_add_shortcut(&app, &state, shortcut.as_deref()) {
        Ok(applied) => Ok(GlobalQuickAddShortcutApplyResult {
            shortcut: applied,
            warning: None,
        }),
        Err(error) => {
            log::warn!(
                "Failed to apply global quick add shortcut; falling back to disabled: {error}"
            );
            let disabled = apply_global_quick_add_shortcut(
                &app,
                &state,
                Some(GLOBAL_QUICK_ADD_SHORTCUT_DISABLED),
            )?;
            Ok(GlobalQuickAddShortcutApplyResult {
                shortcut: disabled,
                warning: Some(
                    "Global quick add shortcut is unavailable (likely already used by another app), so it was disabled."
                        .to_string(),
                ),
            })
        }
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(target_os = "windows")]
fn has_windows_package_identity() -> bool {
    use windows_sys::Win32::Foundation::{APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER};
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;

    let mut package_name_len: u32 = 0;
    // Per Win32 docs, packaged apps return ERROR_INSUFFICIENT_BUFFER on a size probe.
    let status = unsafe { GetCurrentPackageFullName(&mut package_name_len, std::ptr::null_mut()) };
    if status == APPMODEL_ERROR_NO_PACKAGE {
        return false;
    }
    status == ERROR_INSUFFICIENT_BUFFER || (status == 0 && package_name_len > 0)
}

#[cfg(target_os = "windows")]
fn is_windowsapps_mindwtr_path(path: &str) -> bool {
    (path.contains("\\windowsapps\\") || path.contains("/windowsapps/")) && path.contains("mindwtr")
}

#[tauri::command]
fn is_windows_store_install() -> bool {
    #[cfg(target_os = "windows")]
    {
        if has_windows_package_identity() {
            return true;
        }

        if std::env::var_os("APPX_PACKAGE_FAMILY_NAME").is_some()
            || std::env::var_os("APPX_PACKAGE_FULL_NAME").is_some()
            || std::env::var_os("MSIX_PACKAGE_ROOT").is_some()
            || std::env::var_os("PACKAGE_FAMILY_NAME").is_some()
            || std::env::var_os("PACKAGE_FULL_NAME").is_some()
        {
            return true;
        }

        if let Some(path) = current_exe_path_lowercase() {
            if is_windowsapps_mindwtr_path(&path) {
                return true;
            }
        }
        if let Some(path) = current_exe_canonical_path_lowercase() {
            if is_windowsapps_mindwtr_path(&path) {
                return true;
            }
        }

        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn current_exe_path_lowercase() -> Option<String> {
    env::current_exe()
        .ok()
        .and_then(|path| path.to_str().map(|value| value.to_lowercase()))
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn current_exe_canonical_path_lowercase() -> Option<String> {
    env::current_exe()
        .ok()
        .and_then(|path| fs::canonicalize(path).ok())
        .and_then(|path| path.to_str().map(|value| value.to_lowercase()))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn command_succeeds(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd)
        .args(args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn is_homebrew_cask_installed() -> bool {
    if command_succeeds("brew", &["list", "--cask", "mindwtr"]) {
        return true;
    }
    let brew_paths = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
    if brew_paths
        .iter()
        .any(|path| command_succeeds(path, &["list", "--cask", "mindwtr"]))
    {
        return true;
    }
    let caskroom_paths = [
        "/opt/homebrew/Caskroom/mindwtr",
        "/usr/local/Caskroom/mindwtr",
    ];
    caskroom_paths.iter().any(|path| Path::new(path).exists())
}

#[cfg(target_os = "linux")]
fn is_homebrew_install_linux() -> bool {
    if command_succeeds("brew", &["list", "--cask", "mindwtr"])
        || command_succeeds("brew", &["list", "mindwtr"])
    {
        return true;
    }
    let brew_paths = [
        "/home/linuxbrew/.linuxbrew/bin/brew",
        "/opt/homebrew/bin/brew",
        "/usr/local/bin/brew",
    ];
    if brew_paths.iter().any(|path| {
        command_succeeds(path, &["list", "--cask", "mindwtr"])
            || command_succeeds(path, &["list", "mindwtr"])
    }) {
        return true;
    }
    let install_paths = [
        "/home/linuxbrew/.linuxbrew/Caskroom/mindwtr",
        "/home/linuxbrew/.linuxbrew/Cellar/mindwtr",
        "/linuxbrew/.linuxbrew/Caskroom/mindwtr",
        "/linuxbrew/.linuxbrew/Cellar/mindwtr",
    ];
    install_paths.iter().any(|path| Path::new(path).exists())
}

#[cfg(target_os = "windows")]
fn is_winget_install_path(path: &str) -> bool {
    path.contains("\\microsoft\\winget\\packages\\") || path.contains("/microsoft/winget/packages/")
}

#[cfg(target_os = "windows")]
fn command_output_lowercase(cmd: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(cmd)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut combined = String::from_utf8_lossy(&output.stdout).to_lowercase();
    if !output.stderr.is_empty() {
        combined.push('\n');
        combined.push_str(&String::from_utf8_lossy(&output.stderr).to_lowercase());
    }
    Some(combined)
}

#[cfg(target_os = "macos")]
fn find_macos_bundle_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|ancestor| {
            ancestor
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("app"))
                .unwrap_or(false)
        })
        .map(|ancestor| ancestor.to_path_buf())
}

fn detect_install_source() -> String {
    #[cfg(target_os = "windows")]
    {
        if is_windows_store_install() {
            return "microsoft-store".to_string();
        }
        if env::var_os("WINGET_PACKAGE_IDENTIFIER").is_some() {
            return "winget".to_string();
        }
        if let Some(path) = current_exe_path_lowercase() {
            if is_winget_install_path(&path) {
                return "winget".to_string();
            }
        }
        if let Some(path) = current_exe_canonical_path_lowercase() {
            if is_winget_install_path(&path) {
                return "winget".to_string();
            }
        }
        if let Some(list_output) = command_output_lowercase(
            "winget",
            &[
                "list",
                "--id",
                "dongdongbh.Mindwtr",
                "--exact",
                "--disable-interactivity",
            ],
        ) {
            if list_output.contains("dongdongbh.mindwtr") && list_output.contains("winget") {
                return "winget".to_string();
            }
        }
        return "direct".to_string();
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(exe_path) = env::current_exe() {
            if let Some(bundle_root) = find_macos_bundle_root(&exe_path) {
                if bundle_root
                    .join("Contents")
                    .join("_MASReceipt")
                    .join("receipt")
                    .exists()
                {
                    return "mac-app-store".to_string();
                }
            }
        }
        let is_homebrew_path =
            |path: &str| path.contains("/caskroom/") || path.contains("/homebrew/");
        if let Some(path) = current_exe_path_lowercase() {
            if is_homebrew_path(&path) {
                return "homebrew".to_string();
            }
        }
        if let Some(path) = current_exe_canonical_path_lowercase() {
            if is_homebrew_path(&path) {
                return "homebrew".to_string();
            }
        }
        if is_homebrew_cask_installed() {
            return "homebrew".to_string();
        }
        return "direct".to_string();
    }

    #[cfg(target_os = "linux")]
    {
        if is_flatpak() {
            if let Some(channel) = flatpak_install_channel() {
                return format!("flatpak:{channel}");
            }
            return "flatpak".to_string();
        }
        if env::var_os("SNAP").is_some() || env::var_os("SNAP_NAME").is_some() {
            return "snap".to_string();
        }
        if env::var_os("APPIMAGE").is_some() {
            return "appimage".to_string();
        }
        if let Some(path) = current_exe_path_lowercase() {
            if path.ends_with(".appimage") || path.contains(".appimage") {
                return "appimage".to_string();
            }
            if path.contains("/home/linuxbrew/") || path.contains("/linuxbrew/") {
                return "homebrew".to_string();
            }
        }
        if is_homebrew_install_linux() {
            return "homebrew".to_string();
        }
        if command_succeeds("pacman", &["-Q", "mindwtr"]) {
            return "aur-source".to_string();
        }
        if command_succeeds("pacman", &["-Q", "mindwtr-bin"]) {
            return "aur-bin".to_string();
        }
        if command_succeeds("dpkg-query", &["-W", "mindwtr"]) {
            return "apt".to_string();
        }
        if command_succeeds("rpm", &["-q", "mindwtr"]) {
            return "rpm".to_string();
        }
        return "direct".to_string();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "direct".to_string()
    }
}

#[tauri::command]
async fn get_install_source() -> String {
    tauri::async_runtime::spawn_blocking(detect_install_source)
        .await
        .unwrap_or_else(|_| "unknown".to_string())
}

#[tauri::command]
fn start_audio_recording(state: tauri::State<'_, AudioRecorderState>) -> Result<(), String> {
    let mut guard = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Recorder lock poisoned".to_string())?;
    if guard.is_some() {
        return Err("Recording already in progress".into());
    }

    let samples: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
    let info: Arc<Mutex<Option<RecorderInfo>>> = Arc::new(Mutex::new(None));
    let (stop_tx, stop_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();

    let samples_clone = samples.clone();
    let info_clone = info.clone();
    let join = std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match host.default_input_device().or_else(|| {
            host.input_devices()
                .ok()
                .and_then(|mut devices| devices.next())
        }) {
            Some(device) => device,
            None => {
                let _ = ready_tx.send(Err("No audio input device available".to_string()));
                return;
            }
        };
        let config = match device.default_input_config() {
            Ok(cfg) => cfg,
            Err(err) => {
                let _ = ready_tx.send(Err(format!("Failed to read input config: {err}")));
                return;
            }
        };
        let sample_rate = config.sample_rate().0;
        let channels = config.channels();

        let err_fn = |err| {
            eprintln!("[audio] stream error: {err}");
        };

        let stream_config: cpal::StreamConfig = config.clone().into();
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| {
                    let Ok(mut buffer) = samples_clone.lock() else {
                        return;
                    };
                    buffer.extend(data.iter().map(|sample| {
                        let clamped = sample.clamp(-1.0, 1.0);
                        (clamped * i16::MAX as f32) as i16
                    }));
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let Ok(mut buffer) = samples_clone.lock() else {
                        return;
                    };
                    buffer.extend_from_slice(data);
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let Ok(mut buffer) = samples_clone.lock() else {
                        return;
                    };
                    buffer.extend(data.iter().map(|sample| (*sample as i32 - 32768) as i16));
                },
                err_fn,
                None,
            ),
            _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
        };

        let stream = match stream {
            Ok(stream) => stream,
            Err(err) => {
                let _ = ready_tx.send(Err(format!("Failed to create audio stream: {err}")));
                return;
            }
        };

        if let Err(err) = stream.play() {
            let _ = ready_tx.send(Err(format!("Failed to start audio stream: {err}")));
            return;
        }

        if let Ok(mut info_guard) = info_clone.lock() {
            *info_guard = Some(RecorderInfo {
                sample_rate,
                channels,
            });
        }

        let _ = ready_tx.send(Ok(()));

        let _ = stop_rx.recv();
        drop(stream);
    });

    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => {
            *guard = Some(AudioRecorderHandle {
                stop_tx,
                samples,
                info,
                join: Some(join),
            });
            Ok(())
        }
        Ok(Err(err)) => Err(err),
        Err(_) => Err("Audio device did not respond".into()),
    }
}

#[tauri::command]
fn stop_audio_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AudioRecorderState>,
) -> Result<AudioCaptureResult, String> {
    let mut guard = state
        .inner()
        .0
        .lock()
        .map_err(|_| "Recorder lock poisoned".to_string())?;
    let mut recorder = guard
        .take()
        .ok_or_else(|| "No active recording".to_string())?;

    let _ = recorder.stop_tx.send(());
    if let Some(join) = recorder.join.take() {
        let _ = join.join();
    }

    let info = recorder
        .info
        .lock()
        .map_err(|_| "Recorder info lock poisoned".to_string())?;
    let info = info
        .clone()
        .ok_or_else(|| "Recorder did not initialize".to_string())?;
    let samples = recorder
        .samples
        .lock()
        .map_err(|_| "Recorder buffer lock poisoned".to_string())?;
    if samples.is_empty() {
        return Err("No audio captured".into());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let file_name = format!("mindwtr-audio-{timestamp}.wav");
    let relative_path = format!("{}/audio-captures/{}", APP_NAME, file_name);

    let target_dir = get_data_dir(&app).join("audio-captures");
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let target_path = target_dir.join(&file_name);

    let spec = hound::WavSpec {
        channels: info.channels,
        sample_rate: info.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&target_path, spec).map_err(|e| e.to_string())?;
    for sample in samples.iter() {
        writer.write_sample(*sample).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(AudioCaptureResult {
        path: target_path.to_string_lossy().to_string(),
        relative_path,
        sample_rate: info.sample_rate,
        channels: info.channels,
        size: samples.len() * std::mem::size_of::<i16>(),
    })
}

#[tauri::command]
fn transcribe_whisper(
    model_path: String,
    audio_path: String,
    language: Option<String>,
) -> Result<String, String> {
    let model_exists = Path::new(&model_path).exists();
    if !model_exists {
        return Err("Whisper model not found".into());
    }

    let mut reader = hound::WavReader::open(&audio_path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    if spec.channels == 0 || spec.channels > 2 {
        return Err("Unsupported audio channel count".into());
    }

    let mut samples = Vec::new();
    for sample in reader.samples::<i16>() {
        let value = sample.map_err(|e| e.to_string())?;
        samples.push(value);
    }

    let mut audio = vec![0.0f32; samples.len()];
    whisper_rs::convert_integer_to_float_audio(&samples, &mut audio).map_err(|e| e.to_string())?;
    if spec.channels == 2 {
        let mut mono_audio = vec![0.0f32; audio.len() / 2];
        whisper_rs::convert_stereo_to_mono_audio(&audio, &mut mono_audio)
            .map_err(|e| e.to_string())?;
        audio = mono_audio;
    }
    if spec.sample_rate != 16_000 {
        audio = resample_linear(&audio, spec.sample_rate, 16_000);
    }

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    if let Ok(threads) = std::thread::available_parallelism() {
        params.set_n_threads(threads.get() as i32);
    }

    let language_hint = language.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    if let Some(ref lang) = language_hint {
        params.set_language(Some(lang));
    }

    let ctx = WhisperContext::new_with_params(&model_path, WhisperContextParameters::default())
        .map_err(|e| e.to_string())?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    state.full(params, &audio[..]).map_err(|e| e.to_string())?;

    let num_segments = state.full_n_segments();
    let mut text = String::new();
    if num_segments > 0 {
        for i in 0..num_segments {
            if let Some(segment) = state.get_segment(i) {
                if let Ok(seg_text) = segment.to_str_lossy() {
                    text.push_str(&seg_text);
                }
            }
        }
    }

    Ok(text.trim().to_string())
}

fn resample_linear(input: &[f32], input_rate: u32, target_rate: u32) -> Vec<f32> {
    if input_rate == target_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = input_rate as f64 / target_rate as f64;
    let output_len = ((input.len() as f64) / ratio).round().max(1.0) as usize;
    let mut output = Vec::with_capacity(output_len);
    for i in 0..output_len {
        let position = i as f64 * ratio;
        let index = position.floor() as usize;
        let next_index = (index + 1).min(input.len() - 1);
        let frac = position - index as f64;
        let sample = input[index] * (1.0 - frac as f32) + input[next_index] * (frac as f32);
        output.push(sample);
    }
    output
}

#[tauri::command]
fn log_ai_debug(
    context: String,
    message: String,
    provider: Option<String>,
    model: Option<String>,
    task_id: Option<String>,
) {
    println!(
        "[ai-debug] context={} provider={} model={} task={} message={}",
        context,
        provider.unwrap_or_else(|| "unknown".into()),
        model.unwrap_or_else(|| "unknown".into()),
        task_id.unwrap_or_else(|| "-".into()),
        message
    );
}

#[tauri::command]
fn append_log_line(app: tauri::AppHandle, line: String) -> Result<String, String> {
    let log_dir = get_data_dir(&app).join("logs");
    if let Err(err) = std::fs::create_dir_all(&log_dir) {
        return Err(err.to_string());
    }
    let log_path = log_dir.join("mindwtr.log");
    let rotated_path = log_dir.join("mindwtr.log.1");
    let max_bytes: u64 = 5 * 1024 * 1024;

    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() >= max_bytes {
            let _ = std::fs::remove_file(&rotated_path);
            let _ = std::fs::rename(&log_path, &rotated_path);
        }
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    if let Err(err) = file.write_all(line.as_bytes()) {
        return Err(err.to_string());
    }
    if let Err(err) = file.flush() {
        return Err(err.to_string());
    }

    Ok(log_path.to_string_lossy().to_string())
}

#[tauri::command]
fn clear_log_file(app: tauri::AppHandle) -> Result<String, String> {
    let log_path = get_data_dir(&app).join("logs").join("mindwtr.log");
    if log_path.exists() {
        if let Err(err) = std::fs::remove_file(&log_path) {
            return Err(err.to_string());
        }
    }
    Ok(log_path.to_string_lossy().to_string())
}

fn get_config_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .resolve(APP_NAME, BaseDirectory::Config)
        .unwrap_or_else(|_| {
            // Fallback: use a sensible default under the user's home directory.
            let home = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
            home.join(APP_NAME)
        })
}

fn get_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .resolve(APP_NAME, BaseDirectory::Data)
        .unwrap_or_else(|_| {
            let home = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
            home.join(APP_NAME)
        })
}

fn get_config_path(app: &tauri::AppHandle) -> PathBuf {
    get_config_dir(app).join(CONFIG_FILE_NAME)
}

fn get_secrets_path(app: &tauri::AppHandle) -> PathBuf {
    get_config_dir(app).join(SECRETS_FILE_NAME)
}

fn get_data_path(app: &tauri::AppHandle) -> PathBuf {
    get_data_dir(app).join(DATA_FILE_NAME)
}

fn get_db_path(app: &tauri::AppHandle) -> PathBuf {
    get_data_dir(app).join(DB_FILE_NAME)
}

fn open_sqlite(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = get_db_path(app);
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(SQLITE_SCHEMA)
        .map_err(|e| e.to_string())?;
    ensure_tasks_purged_at_column(&conn)?;
    ensure_tasks_order_column(&conn)?;
    ensure_tasks_area_column(&conn)?;
    ensure_tasks_section_column(&conn)?;
    ensure_projects_order_column(&conn)?;
    ensure_projects_area_order_index(&conn)?;
    ensure_sync_revision_columns(&conn)?;
    ensure_fts_triggers(&conn)?;
    ensure_fts_populated(&conn, false)?;
    Ok(conn)
}

fn is_retryable_storage_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("database is locked")
        || normalized.contains("database is busy")
        || normalized.contains("resource busy")
        || normalized.contains("temporarily unavailable")
}

fn write_data_json_file(data_path: &Path, data: &Value) -> Result<(), String> {
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let backup_path = data_path.with_extension("json.bak");
    if data_path.exists() {
        let _ = fs::copy(data_path, &backup_path);
    }
    let tmp_path = data_path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    {
        let mut file = File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    if cfg!(windows) && data_path.exists() {
        fs::remove_file(data_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_path, data_path).map_err(|e| e.to_string())?;
    Ok(())
}

fn persist_data_snapshot(app: &tauri::AppHandle, data: &Value) -> Result<(), String> {
    ensure_data_file(app)?;
    let mut conn = open_sqlite(app)?;
    migrate_json_to_sqlite(&mut conn, data)?;
    write_data_json_file(&get_data_path(app), data)?;
    Ok(())
}

fn persist_data_snapshot_with_retries(app: &tauri::AppHandle, data: &Value) -> Result<(), String> {
    for attempt in 0..STORAGE_RETRY_ATTEMPTS {
        match persist_data_snapshot(app, data) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let can_retry =
                    is_retryable_storage_error(&error) && attempt + 1 < STORAGE_RETRY_ATTEMPTS;
                if can_retry {
                    let delay = STORAGE_RETRY_BASE_DELAY_MS * (attempt as u64 + 1);
                    std::thread::sleep(Duration::from_millis(delay));
                    continue;
                }
                return Err(error);
            }
        }
    }
    Err("Failed to save data".to_string())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let pragma = format!("PRAGMA table_info({})", table);
    let mut stmt = conn.prepare(&pragma).map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for col in columns {
        if col.map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    column_sql: &str,
) -> Result<(), String> {
    if has_column(conn, table, column)? {
        return Ok(());
    }
    let statement = format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, column_sql);
    conn.execute(&statement, []).map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_sync_revision_columns(conn: &Connection) -> Result<(), String> {
    ensure_column(conn, "tasks", "rev", "INTEGER")?;
    ensure_column(conn, "tasks", "revBy", "TEXT")?;
    ensure_column(conn, "projects", "rev", "INTEGER")?;
    ensure_column(conn, "projects", "revBy", "TEXT")?;
    ensure_column(conn, "sections", "rev", "INTEGER")?;
    ensure_column(conn, "sections", "revBy", "TEXT")?;
    ensure_column(conn, "areas", "deletedAt", "TEXT")?;
    ensure_column(conn, "areas", "rev", "INTEGER")?;
    ensure_column(conn, "areas", "revBy", "TEXT")?;
    Ok(())
}

fn ensure_tasks_purged_at_column(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(tasks)")
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for col in columns {
        if col.map_err(|e| e.to_string())? == "purgedAt" {
            return Ok(());
        }
    }
    conn.execute("ALTER TABLE tasks ADD COLUMN purgedAt TEXT", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_tasks_order_column(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(tasks)")
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for col in columns {
        if col.map_err(|e| e.to_string())? == "orderNum" {
            return Ok(());
        }
    }
    conn.execute("ALTER TABLE tasks ADD COLUMN orderNum INTEGER", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_tasks_area_column(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(tasks)")
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    let mut has_area = false;
    for col in columns {
        if col.map_err(|e| e.to_string())? == "areaId" {
            has_area = true;
            break;
        }
    }
    if !has_area {
        conn.execute("ALTER TABLE tasks ADD COLUMN areaId TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_area_id ON tasks(areaId)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_tasks_section_column(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(tasks)")
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    let mut has_section = false;
    for col in columns {
        if col.map_err(|e| e.to_string())? == "sectionId" {
            has_section = true;
            break;
        }
    }
    if !has_section {
        conn.execute("ALTER TABLE tasks ADD COLUMN sectionId TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_section_id ON tasks(sectionId)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_projects_order_column(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(projects)")
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for col in columns {
        if col.map_err(|e| e.to_string())? == "orderNum" {
            return Ok(());
        }
    }
    conn.execute("ALTER TABLE projects ADD COLUMN orderNum INTEGER", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_projects_area_order_index(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(projects)")
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    let mut has_order = false;
    for col in columns {
        if col.map_err(|e| e.to_string())? == "orderNum" {
            has_order = true;
            break;
        }
    }
    if has_order {
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_projects_area_order ON projects(areaId, orderNum)",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_fts_triggers(conn: &Connection) -> Result<(), String> {
    let has_v2: Option<i64> = conn
        .query_row(
            "SELECT version FROM schema_migrations WHERE version = 2 LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if has_v2.is_some() {
        return Ok(());
    }

    conn.execute("DROP TRIGGER IF EXISTS tasks_ad", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TRIGGER IF EXISTS tasks_au", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TRIGGER IF EXISTS projects_ad", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TRIGGER IF EXISTS projects_au", [])
        .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TRIGGER tasks_ad AFTER DELETE ON tasks BEGIN
          INSERT INTO tasks_fts (tasks_fts, id, title, description, tags, contexts)
          VALUES ('delete', old.id, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''));
        END",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TRIGGER tasks_au AFTER UPDATE ON tasks BEGIN
          INSERT INTO tasks_fts (tasks_fts, id, title, description, tags, contexts)
          VALUES ('delete', old.id, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''));
          INSERT INTO tasks_fts (id, title, description, tags, contexts)
          VALUES (new.id, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''));
        END",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TRIGGER projects_ad AFTER DELETE ON projects BEGIN
          INSERT INTO projects_fts (projects_fts, id, title, supportNotes, tagIds, areaTitle)
          VALUES ('delete', old.id, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
        END",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TRIGGER projects_au AFTER UPDATE ON projects BEGIN
          INSERT INTO projects_fts (projects_fts, id, title, supportNotes, tagIds, areaTitle)
          VALUES ('delete', old.id, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
          INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
          VALUES (new.id, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
        END",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (version) VALUES (2)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn sqlite_has_any_data(conn: &Connection) -> Result<bool, String> {
    let task_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let project_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let area_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM areas", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let settings_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    Ok(task_count > 0 || project_count > 0 || area_count > 0 || settings_count > 0)
}

fn ensure_fts_populated(conn: &Connection, force_rebuild: bool) -> Result<(), String> {
    let tasks_fts_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks_fts", [], |row| row.get(0))
        .unwrap_or(0);
    let missing_tasks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE id NOT IN (SELECT id FROM tasks_fts)",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let extra_tasks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks_fts WHERE id NOT IN (SELECT id FROM tasks)",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if force_rebuild || tasks_fts_count == 0 || missing_tasks > 0 || extra_tasks > 0 {
        conn.execute("INSERT INTO tasks_fts(tasks_fts) VALUES('delete-all')", [])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO tasks_fts (id, title, description, tags, contexts)
             SELECT id, title, coalesce(description, ''), coalesce(tags, ''), coalesce(contexts, '') FROM tasks",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    let projects_fts_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM projects_fts", [], |row| row.get(0))
        .unwrap_or(0);
    let missing_projects: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM projects WHERE id NOT IN (SELECT id FROM projects_fts)",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let extra_projects: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM projects_fts WHERE id NOT IN (SELECT id FROM projects)",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if force_rebuild || projects_fts_count == 0 || missing_projects > 0 || extra_projects > 0 {
        conn.execute(
            "INSERT INTO projects_fts(projects_fts) VALUES('delete-all')",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
             SELECT id, title, coalesce(supportNotes, ''), coalesce(tagIds, ''), coalesce(areaTitle, '') FROM projects",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn json_str(value: Option<&Value>) -> Option<String> {
    value.and_then(|v| serde_json::to_string(v).ok())
}

fn json_str_or_default(value: Option<&Value>, default: &str) -> String {
    json_str(value).unwrap_or_else(|| default.to_string())
}

fn parse_json_value(raw: Option<String>) -> Value {
    if let Some(text) = raw {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            return value;
        }
    }
    Value::Null
}

fn parse_json_array(raw: Option<String>) -> Value {
    match parse_json_value(raw) {
        Value::Array(arr) => Value::Array(arr),
        _ => Value::Array(Vec::new()),
    }
}

fn build_fts_query(input: &str) -> Option<String> {
    let mut cleaned = String::new();
    for ch in input.chars() {
        if ch.is_alphanumeric() || ch == '#' || ch == '@' {
            cleaned.push(ch);
        } else {
            cleaned.push(' ');
        }
    }
    let tokens: Vec<String> = cleaned
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("{}*", t))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

fn row_to_task_value(row: &rusqlite::Row<'_>) -> Result<Value, rusqlite::Error> {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), Value::String(row.get::<_, String>("id")?));
    map.insert(
        "title".to_string(),
        Value::String(row.get::<_, String>("title")?),
    );
    map.insert(
        "status".to_string(),
        Value::String(row.get::<_, String>("status")?),
    );
    if let Ok(val) = row.get::<_, Option<String>>("priority") {
        if let Some(v) = val {
            map.insert("priority".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("taskMode") {
        if let Some(v) = val {
            map.insert("taskMode".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("startTime") {
        if let Some(v) = val {
            map.insert("startTime".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("dueDate") {
        if let Some(v) = val {
            map.insert("dueDate".to_string(), Value::String(v));
        }
    }
    let recurrence_raw: Option<String> = row.get("recurrence")?;
    let recurrence_val = parse_json_value(recurrence_raw);
    if !recurrence_val.is_null() {
        map.insert("recurrence".to_string(), recurrence_val);
    }
    if let Ok(val) = row.get::<_, Option<i64>>("pushCount") {
        if let Some(v) = val {
            map.insert("pushCount".to_string(), Value::Number(v.into()));
        }
    }
    let tags_raw: Option<String> = row.get("tags")?;
    map.insert("tags".to_string(), parse_json_array(tags_raw));
    let contexts_raw: Option<String> = row.get("contexts")?;
    map.insert("contexts".to_string(), parse_json_array(contexts_raw));
    let checklist_raw: Option<String> = row.get("checklist")?;
    let checklist_val = parse_json_value(checklist_raw);
    if !checklist_val.is_null() {
        map.insert("checklist".to_string(), checklist_val);
    }
    if let Ok(val) = row.get::<_, Option<String>>("description") {
        if let Some(v) = val {
            map.insert("description".to_string(), Value::String(v));
        }
    }
    let attachments_raw: Option<String> = row.get("attachments")?;
    let attachments_val = parse_json_value(attachments_raw);
    if !attachments_val.is_null() {
        map.insert("attachments".to_string(), attachments_val);
    }
    if let Ok(val) = row.get::<_, Option<String>>("location") {
        if let Some(v) = val {
            map.insert("location".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("projectId") {
        if let Some(v) = val {
            map.insert("projectId".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("sectionId") {
        if let Some(v) = val {
            map.insert("sectionId".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("areaId") {
        if let Some(v) = val {
            map.insert("areaId".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<i64>>("orderNum") {
        if let Some(v) = val {
            map.insert("orderNum".to_string(), Value::Number(v.into()));
        }
    }
    if let Ok(val) = row.get::<_, i64>("isFocusedToday") {
        if val != 0 {
            map.insert("isFocusedToday".to_string(), Value::Bool(true));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("timeEstimate") {
        if let Some(v) = val {
            map.insert("timeEstimate".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("reviewAt") {
        if let Some(v) = val {
            map.insert("reviewAt".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("completedAt") {
        if let Some(v) = val {
            map.insert("completedAt".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<i64>>("rev") {
        if let Some(v) = val {
            map.insert("rev".to_string(), Value::Number(v.into()));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("revBy") {
        if let Some(v) = val {
            map.insert("revBy".to_string(), Value::String(v));
        }
    }
    map.insert(
        "createdAt".to_string(),
        Value::String(row.get::<_, String>("createdAt")?),
    );
    map.insert(
        "updatedAt".to_string(),
        Value::String(row.get::<_, String>("updatedAt")?),
    );
    if let Ok(val) = row.get::<_, Option<String>>("deletedAt") {
        if let Some(v) = val {
            map.insert("deletedAt".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("purgedAt") {
        if let Some(v) = val {
            map.insert("purgedAt".to_string(), Value::String(v));
        }
    }
    Ok(Value::Object(map))
}

fn row_to_project_value(row: &rusqlite::Row<'_>) -> Result<Value, rusqlite::Error> {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), Value::String(row.get::<_, String>("id")?));
    map.insert(
        "title".to_string(),
        Value::String(row.get::<_, String>("title")?),
    );
    map.insert(
        "status".to_string(),
        Value::String(row.get::<_, String>("status")?),
    );
    map.insert(
        "color".to_string(),
        Value::String(row.get::<_, String>("color")?),
    );
    if let Ok(val) = row.get::<_, Option<i64>>("orderNum") {
        if let Some(v) = val {
            map.insert("order".to_string(), Value::Number(v.into()));
        }
    }
    let tag_ids_raw: Option<String> = row.get("tagIds")?;
    map.insert("tagIds".to_string(), parse_json_array(tag_ids_raw));
    if let Ok(val) = row.get::<_, i64>("isSequential") {
        if val != 0 {
            map.insert("isSequential".to_string(), Value::Bool(true));
        }
    }
    if let Ok(val) = row.get::<_, i64>("isFocused") {
        if val != 0 {
            map.insert("isFocused".to_string(), Value::Bool(true));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("supportNotes") {
        if let Some(v) = val {
            map.insert("supportNotes".to_string(), Value::String(v));
        }
    }
    let attachments_raw: Option<String> = row.get("attachments")?;
    let attachments_val = parse_json_value(attachments_raw);
    if !attachments_val.is_null() {
        map.insert("attachments".to_string(), attachments_val);
    }
    if let Ok(val) = row.get::<_, Option<String>>("reviewAt") {
        if let Some(v) = val {
            map.insert("reviewAt".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("areaId") {
        if let Some(v) = val {
            map.insert("areaId".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("areaTitle") {
        if let Some(v) = val {
            map.insert("areaTitle".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<i64>>("rev") {
        if let Some(v) = val {
            map.insert("rev".to_string(), Value::Number(v.into()));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("revBy") {
        if let Some(v) = val {
            map.insert("revBy".to_string(), Value::String(v));
        }
    }
    map.insert(
        "createdAt".to_string(),
        Value::String(row.get::<_, String>("createdAt")?),
    );
    map.insert(
        "updatedAt".to_string(),
        Value::String(row.get::<_, String>("updatedAt")?),
    );
    if let Ok(val) = row.get::<_, Option<String>>("deletedAt") {
        if let Some(v) = val {
            map.insert("deletedAt".to_string(), Value::String(v));
        }
    }
    Ok(Value::Object(map))
}

fn row_to_section_value(row: &rusqlite::Row<'_>) -> Result<Value, rusqlite::Error> {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), Value::String(row.get::<_, String>("id")?));
    map.insert(
        "projectId".to_string(),
        Value::String(row.get::<_, String>("projectId")?),
    );
    map.insert(
        "title".to_string(),
        Value::String(row.get::<_, String>("title")?),
    );
    if let Ok(val) = row.get::<_, Option<String>>("description") {
        if let Some(v) = val {
            map.insert("description".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<i64>>("orderNum") {
        if let Some(v) = val {
            map.insert("order".to_string(), Value::Number(v.into()));
        }
    }
    if let Ok(val) = row.get::<_, i64>("isCollapsed") {
        if val != 0 {
            map.insert("isCollapsed".to_string(), Value::Bool(true));
        }
    }
    if let Ok(val) = row.get::<_, Option<i64>>("rev") {
        if let Some(v) = val {
            map.insert("rev".to_string(), Value::Number(v.into()));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("revBy") {
        if let Some(v) = val {
            map.insert("revBy".to_string(), Value::String(v));
        }
    }
    map.insert(
        "createdAt".to_string(),
        Value::String(row.get::<_, String>("createdAt")?),
    );
    map.insert(
        "updatedAt".to_string(),
        Value::String(row.get::<_, String>("updatedAt")?),
    );
    if let Ok(val) = row.get::<_, Option<String>>("deletedAt") {
        if let Some(v) = val {
            map.insert("deletedAt".to_string(), Value::String(v));
        }
    }
    Ok(Value::Object(map))
}

fn migrate_json_to_sqlite(conn: &mut Connection, data: &Value) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM tasks", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM projects", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM areas", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sections", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM settings", [])
        .map_err(|e| e.to_string())?;

    let tasks = data
        .get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for task in tasks {
        let tags_json = json_str_or_default(task.get("tags"), "[]");
        let contexts_json = json_str_or_default(task.get("contexts"), "[]");
        let recurrence_json = json_str(task.get("recurrence"));
        let checklist_json = json_str(task.get("checklist"));
        let attachments_json = json_str(task.get("attachments"));
        tx.execute(
            "INSERT OR REPLACE INTO tasks (id, title, status, priority, taskMode, startTime, dueDate, recurrence, pushCount, tags, contexts, checklist, description, attachments, location, projectId, sectionId, areaId, orderNum, isFocusedToday, timeEstimate, reviewAt, completedAt, rev, revBy, createdAt, updatedAt, deletedAt, purgedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)",
            params![
                task.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("title").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("status").and_then(|v| v.as_str()).unwrap_or("inbox"),
                task.get("priority").and_then(|v| v.as_str()),
                task.get("taskMode").and_then(|v| v.as_str()),
                task.get("startTime").and_then(|v| v.as_str()),
                task.get("dueDate").and_then(|v| v.as_str()),
                recurrence_json,
                task.get("pushCount").and_then(|v| v.as_i64()),
                tags_json,
                contexts_json,
                checklist_json,
                task.get("description").and_then(|v| v.as_str()),
                attachments_json,
                task.get("location").and_then(|v| v.as_str()),
                task.get("projectId").and_then(|v| v.as_str()),
                task.get("sectionId").and_then(|v| v.as_str()),
                task.get("areaId").and_then(|v| v.as_str()),
                task.get("orderNum").and_then(|v| v.as_i64()),
                task.get("isFocusedToday").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                task.get("timeEstimate").and_then(|v| v.as_str()),
                task.get("reviewAt").and_then(|v| v.as_str()),
                task.get("completedAt").and_then(|v| v.as_str()),
                task.get("rev").and_then(|v| v.as_i64()),
                task.get("revBy").and_then(|v| v.as_str()),
                task.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("deletedAt").and_then(|v| v.as_str()),
                task.get("purgedAt").and_then(|v| v.as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let projects = data
        .get("projects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for project in projects {
        let tag_ids_json = json_str_or_default(project.get("tagIds"), "[]");
        let attachments_json = json_str(project.get("attachments"));
        tx.execute(
            "INSERT OR REPLACE INTO projects (id, title, status, color, orderNum, tagIds, isSequential, isFocused, supportNotes, attachments, reviewAt, areaId, areaTitle, rev, revBy, createdAt, updatedAt, deletedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                project.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("title").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("status").and_then(|v| v.as_str()).unwrap_or("active"),
                project.get("color").and_then(|v| v.as_str()).unwrap_or("#6B7280"),
                project.get("order").and_then(|v| v.as_i64()),
                tag_ids_json,
                project.get("isSequential").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                project.get("isFocused").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                project.get("supportNotes").and_then(|v| v.as_str()),
                attachments_json,
                project.get("reviewAt").and_then(|v| v.as_str()),
                project.get("areaId").and_then(|v| v.as_str()),
                project.get("areaTitle").and_then(|v| v.as_str()),
                project.get("rev").and_then(|v| v.as_i64()),
                project.get("revBy").and_then(|v| v.as_str()),
                project.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("deletedAt").and_then(|v| v.as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let areas = data
        .get("areas")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for area in areas {
        tx.execute(
            "INSERT OR REPLACE INTO areas (id, name, color, icon, orderNum, deletedAt, rev, revBy, createdAt, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                area.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                area.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
                area.get("color").and_then(|v| v.as_str()),
                area.get("icon").and_then(|v| v.as_str()),
                area.get("order").and_then(|v| v.as_i64()).unwrap_or(0),
                area.get("deletedAt").and_then(|v| v.as_str()),
                area.get("rev").and_then(|v| v.as_i64()),
                area.get("revBy").and_then(|v| v.as_str()),
                area.get("createdAt").and_then(|v| v.as_str()),
                area.get("updatedAt").and_then(|v| v.as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let sections = data
        .get("sections")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for section in sections {
        tx.execute(
            "INSERT OR REPLACE INTO sections (id, projectId, title, description, orderNum, isCollapsed, rev, revBy, createdAt, updatedAt, deletedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                section.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                section.get("projectId").and_then(|v| v.as_str()).unwrap_or_default(),
                section.get("title").and_then(|v| v.as_str()).unwrap_or_default(),
                section.get("description").and_then(|v| v.as_str()),
                section.get("order").and_then(|v| v.as_i64()),
                section.get("isCollapsed").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                section.get("rev").and_then(|v| v.as_i64()),
                section.get("revBy").and_then(|v| v.as_str()),
                section.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
                section.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
                section.get("deletedAt").and_then(|v| v.as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let settings_json = json_str(data.get("settings"));
    tx.execute(
        "INSERT INTO settings (id, data) VALUES (1, ?1)",
        params![settings_json.unwrap_or_else(|| "{}".to_string())],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn read_sqlite_data(conn: &Connection) -> Result<Value, String> {
    let mut tasks_stmt = conn
        .prepare("SELECT * FROM tasks")
        .map_err(|e| e.to_string())?;
    let task_rows = tasks_stmt
        .query_map([], |row| row_to_task_value(row))
        .map_err(|e| e.to_string())?;
    let mut tasks: Vec<Value> = Vec::new();
    for row in task_rows {
        tasks.push(row.map_err(|e| e.to_string())?);
    }

    let mut projects_stmt = conn
        .prepare("SELECT * FROM projects")
        .map_err(|e| e.to_string())?;
    let project_rows = projects_stmt
        .query_map([], |row| row_to_project_value(row))
        .map_err(|e| e.to_string())?;
    let mut projects: Vec<Value> = Vec::new();
    for row in project_rows {
        projects.push(row.map_err(|e| e.to_string())?);
    }

    let mut sections_stmt = conn
        .prepare("SELECT * FROM sections")
        .map_err(|e| e.to_string())?;
    let section_rows = sections_stmt
        .query_map([], |row| row_to_section_value(row))
        .map_err(|e| e.to_string())?;
    let mut sections: Vec<Value> = Vec::new();
    for row in section_rows {
        sections.push(row.map_err(|e| e.to_string())?);
    }

    let mut areas_stmt = conn
        .prepare("SELECT * FROM areas")
        .map_err(|e| e.to_string())?;
    let area_rows = areas_stmt
        .query_map([], |row| {
            let mut map = serde_json::Map::new();
            map.insert("id".to_string(), Value::String(row.get::<_, String>("id")?));
            map.insert(
                "name".to_string(),
                Value::String(row.get::<_, String>("name")?),
            );
            if let Ok(val) = row.get::<_, Option<String>>("color") {
                if let Some(v) = val {
                    map.insert("color".to_string(), Value::String(v));
                }
            }
            if let Ok(val) = row.get::<_, Option<String>>("icon") {
                if let Some(v) = val {
                    map.insert("icon".to_string(), Value::String(v));
                }
            }
            map.insert(
                "order".to_string(),
                Value::Number((row.get::<_, i64>("orderNum")?).into()),
            );
            if let Ok(val) = row.get::<_, Option<String>>("deletedAt") {
                if let Some(v) = val {
                    map.insert("deletedAt".to_string(), Value::String(v));
                }
            }
            if let Ok(val) = row.get::<_, Option<i64>>("rev") {
                if let Some(v) = val {
                    map.insert("rev".to_string(), Value::Number(v.into()));
                }
            }
            if let Ok(val) = row.get::<_, Option<String>>("revBy") {
                if let Some(v) = val {
                    map.insert("revBy".to_string(), Value::String(v));
                }
            }
            if let Ok(val) = row.get::<_, Option<String>>("createdAt") {
                if let Some(v) = val {
                    map.insert("createdAt".to_string(), Value::String(v));
                }
            }
            if let Ok(val) = row.get::<_, Option<String>>("updatedAt") {
                if let Some(v) = val {
                    map.insert("updatedAt".to_string(), Value::String(v));
                }
            }
            Ok(Value::Object(map))
        })
        .map_err(|e| e.to_string())?;
    let mut areas: Vec<Value> = Vec::new();
    for row in area_rows {
        areas.push(row.map_err(|e| e.to_string())?);
    }

    let settings_raw: Option<String> = conn
        .query_row("SELECT data FROM settings WHERE id = 1", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let settings_val = parse_json_value(settings_raw)
        .as_object()
        .cloned()
        .unwrap_or_default();

    Ok(Value::Object(
        serde_json::json!({
            "tasks": tasks,
            "projects": projects,
            "sections": sections,
            "areas": areas,
            "settings": Value::Object(settings_val),
        })
        .as_object()
        .unwrap()
        .clone(),
    ))
}

fn get_legacy_config_json_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| get_config_dir(app))
        .join("config.json")
}

fn get_legacy_data_json_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| get_data_dir(app))
        .join(DATA_FILE_NAME)
}

fn parse_toml_string_value(raw: &str) -> Option<String> {
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

fn parse_os_release_value(raw: &str) -> String {
    parse_toml_string_value(raw)
        .unwrap_or_else(|| raw.trim().trim_matches('"').trim_matches('\'').to_string())
}

fn serialize_toml_string_value(value: &str) -> String {
    // Use TOML basic strings with minimal escaping.
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

fn read_config_toml(path: &Path) -> AppConfigToml {
    let Ok(content) = fs::read_to_string(path) else {
        return AppConfigToml::default();
    };

    let mut config = AppConfigToml::default();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key == "sync_path" {
            config.sync_path = parse_toml_string_value(value);
        } else if key == "sync_path_bookmark" {
            config.sync_path_bookmark = parse_toml_string_value(value);
        } else if key == "sync_backend" {
            config.sync_backend = parse_toml_string_value(value);
        } else if key == "webdav_url" {
            config.webdav_url = parse_toml_string_value(value);
        } else if key == "webdav_username" {
            config.webdav_username = parse_toml_string_value(value);
        } else if key == "webdav_password" {
            config.webdav_password = parse_toml_string_value(value);
        } else if key == "cloud_url" {
            config.cloud_url = parse_toml_string_value(value);
        } else if key == "cloud_token" {
            config.cloud_token = parse_toml_string_value(value);
        } else if key == "dropbox_tokens" {
            config.dropbox_tokens = parse_toml_string_value(value);
        } else if key == "obsidian_config" {
            config.obsidian_config = parse_toml_string_value(value);
        } else if key == "external_calendars" {
            config.external_calendars = parse_toml_string_value(value);
        } else if key == "ai_key_openai" {
            config.ai_key_openai = parse_toml_string_value(value);
        } else if key == "ai_key_anthropic" {
            config.ai_key_anthropic = parse_toml_string_value(value);
        } else if key == "ai_key_gemini" {
            config.ai_key_gemini = parse_toml_string_value(value);
        }
    }
    config
}

#[tauri::command]
fn get_linux_distro() -> Option<LinuxDistroInfo> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let content = fs::read_to_string("/etc/os-release").ok()?;
    let mut id: Option<String> = None;
    let mut id_like: Vec<String> = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("ID=") {
            if let Some(value) = line.split_once('=').map(|(_, v)| v) {
                let parsed = parse_os_release_value(value);
                if !parsed.is_empty() {
                    id = Some(parsed);
                }
            }
        } else if line.starts_with("ID_LIKE=") {
            if let Some(value) = line.split_once('=').map(|(_, v)| v) {
                let parsed = parse_os_release_value(value);
                if !parsed.is_empty() {
                    id_like = parsed
                        .split_whitespace()
                        .map(|item| item.trim().to_string())
                        .filter(|item| !item.is_empty())
                        .collect();
                }
            }
        }
    }

    Some(LinuxDistroInfo { id, id_like })
}

fn write_config_toml(path: &Path, config: &AppConfigToml) -> Result<(), String> {
    write_config_toml_with_header(path, config, "# Mindwtr desktop config")
}

fn write_secrets_toml(path: &Path, config: &AppConfigToml) -> Result<(), String> {
    write_config_toml_with_header(path, config, "# Mindwtr desktop secrets")
}

fn write_config_toml_with_header(
    path: &Path,
    config: &AppConfigToml,
    header: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push(header.to_string());
    if let Some(sync_path) = &config.sync_path {
        lines.push(format!(
            "sync_path = {}",
            serialize_toml_string_value(sync_path)
        ));
    }
    if let Some(sync_path_bookmark) = &config.sync_path_bookmark {
        lines.push(format!(
            "sync_path_bookmark = {}",
            serialize_toml_string_value(sync_path_bookmark)
        ));
    }
    if let Some(sync_backend) = &config.sync_backend {
        lines.push(format!(
            "sync_backend = {}",
            serialize_toml_string_value(sync_backend)
        ));
    }
    if let Some(webdav_url) = &config.webdav_url {
        lines.push(format!(
            "webdav_url = {}",
            serialize_toml_string_value(webdav_url)
        ));
    }
    if let Some(webdav_username) = &config.webdav_username {
        lines.push(format!(
            "webdav_username = {}",
            serialize_toml_string_value(webdav_username)
        ));
    }
    if let Some(webdav_password) = &config.webdav_password {
        lines.push(format!(
            "webdav_password = {}",
            serialize_toml_string_value(webdav_password)
        ));
    }
    if let Some(cloud_url) = &config.cloud_url {
        lines.push(format!(
            "cloud_url = {}",
            serialize_toml_string_value(cloud_url)
        ));
    }
    if let Some(cloud_token) = &config.cloud_token {
        lines.push(format!(
            "cloud_token = {}",
            serialize_toml_string_value(cloud_token)
        ));
    }
    if let Some(dropbox_tokens) = &config.dropbox_tokens {
        lines.push(format!(
            "dropbox_tokens = {}",
            serialize_toml_string_value(dropbox_tokens)
        ));
    }
    if let Some(obsidian_config) = &config.obsidian_config {
        lines.push(format!(
            "obsidian_config = {}",
            serialize_toml_string_value(obsidian_config)
        ));
    }
    if let Some(external_calendars) = &config.external_calendars {
        lines.push(format!(
            "external_calendars = {}",
            serialize_toml_string_value(external_calendars)
        ));
    }
    if let Some(ai_key_openai) = &config.ai_key_openai {
        lines.push(format!(
            "ai_key_openai = {}",
            serialize_toml_string_value(ai_key_openai)
        ));
    }
    if let Some(ai_key_anthropic) = &config.ai_key_anthropic {
        lines.push(format!(
            "ai_key_anthropic = {}",
            serialize_toml_string_value(ai_key_anthropic)
        ));
    }
    if let Some(ai_key_gemini) = &config.ai_key_gemini {
        lines.push(format!(
            "ai_key_gemini = {}",
            serialize_toml_string_value(ai_key_gemini)
        ));
    }
    let content = format!("{}\n", lines.join("\n"));
    fs::write(path, content).map_err(|e| e.to_string())
}

fn merge_config(base: &mut AppConfigToml, overrides: AppConfigToml) {
    if overrides.sync_path.is_some() {
        base.sync_path = overrides.sync_path;
    }
    if overrides.sync_path_bookmark.is_some() {
        base.sync_path_bookmark = overrides.sync_path_bookmark;
    }
    if overrides.sync_backend.is_some() {
        base.sync_backend = overrides.sync_backend;
    }
    if overrides.webdav_url.is_some() {
        base.webdav_url = overrides.webdav_url;
    }
    if overrides.webdav_username.is_some() {
        base.webdav_username = overrides.webdav_username;
    }
    if overrides.webdav_password.is_some() {
        base.webdav_password = overrides.webdav_password;
    }
    if overrides.cloud_url.is_some() {
        base.cloud_url = overrides.cloud_url;
    }
    if overrides.cloud_token.is_some() {
        base.cloud_token = overrides.cloud_token;
    }
    if overrides.dropbox_tokens.is_some() {
        base.dropbox_tokens = overrides.dropbox_tokens;
    }
    if overrides.obsidian_config.is_some() {
        base.obsidian_config = overrides.obsidian_config;
    }
    if overrides.external_calendars.is_some() {
        base.external_calendars = overrides.external_calendars;
    }
    if overrides.ai_key_openai.is_some() {
        base.ai_key_openai = overrides.ai_key_openai;
    }
    if overrides.ai_key_anthropic.is_some() {
        base.ai_key_anthropic = overrides.ai_key_anthropic;
    }
    if overrides.ai_key_gemini.is_some() {
        base.ai_key_gemini = overrides.ai_key_gemini;
    }
}

fn read_config(app: &tauri::AppHandle) -> AppConfigToml {
    let mut config = read_config_toml(&get_config_path(app));
    let secrets_path = get_secrets_path(app);
    if secrets_path.exists() {
        let secrets = read_config_toml(&secrets_path);
        merge_config(&mut config, secrets);
    }
    migrate_legacy_secrets(app, &mut config);
    config
}

fn split_config_for_secrets(config: &AppConfigToml) -> (AppConfigToml, AppConfigToml) {
    let mut public_config = config.clone();
    let mut secrets_config = AppConfigToml::default();

    if let Some(value) = config.webdav_password.clone() {
        secrets_config.webdav_password = Some(value);
        public_config.webdav_password = None;
    }
    if let Some(value) = config.cloud_token.clone() {
        secrets_config.cloud_token = Some(value);
        public_config.cloud_token = None;
    }
    if let Some(value) = config.dropbox_tokens.clone() {
        secrets_config.dropbox_tokens = Some(value);
        public_config.dropbox_tokens = None;
    }
    if let Some(value) = config.external_calendars.clone() {
        secrets_config.external_calendars = Some(value);
        public_config.external_calendars = None;
    }
    if let Some(value) = config.ai_key_openai.clone() {
        secrets_config.ai_key_openai = Some(value);
        public_config.ai_key_openai = None;
    }
    if let Some(value) = config.ai_key_anthropic.clone() {
        secrets_config.ai_key_anthropic = Some(value);
        public_config.ai_key_anthropic = None;
    }
    if let Some(value) = config.ai_key_gemini.clone() {
        secrets_config.ai_key_gemini = Some(value);
        public_config.ai_key_gemini = None;
    }

    (public_config, secrets_config)
}

fn config_has_values(config: &AppConfigToml) -> bool {
    config.sync_path.is_some()
        || config.sync_path_bookmark.is_some()
        || config.sync_backend.is_some()
        || config.webdav_url.is_some()
        || config.webdav_username.is_some()
        || config.webdav_password.is_some()
        || config.cloud_url.is_some()
        || config.cloud_token.is_some()
        || config.dropbox_tokens.is_some()
        || config.obsidian_config.is_some()
        || config.external_calendars.is_some()
        || config.ai_key_openai.is_some()
        || config.ai_key_anthropic.is_some()
        || config.ai_key_gemini.is_some()
}

fn write_config_files(
    config_path: &Path,
    secrets_path: &Path,
    config: &AppConfigToml,
) -> Result<(), String> {
    let (public_config, secrets_config) = split_config_for_secrets(config);
    write_config_toml(config_path, &public_config)?;

    if config_has_values(&secrets_config) {
        write_secrets_toml(secrets_path, &secrets_config)?;
    } else if secrets_path.exists() {
        fs::remove_file(secrets_path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn migrate_legacy_secrets(app: &tauri::AppHandle, config: &mut AppConfigToml) {
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

fn get_keyring_secret(app: &tauri::AppHandle, key: &str) -> Result<Option<String>, String> {
    let entry = keyring_entry(app, key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn set_keyring_secret(
    app: &tauri::AppHandle,
    key: &str,
    value: Option<String>,
) -> Result<(), String> {
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
) -> Result<DropboxTokenBundle, String> {
    let client = reqwest::blocking::Client::new();
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

fn refresh_dropbox_token(client_id: &str, refresh_token: &str) -> Result<(String, i64), String> {
    let client = reqwest::blocking::Client::new();
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

fn read_dropbox_tokens(app: &tauri::AppHandle) -> Result<Option<DropboxTokenBundle>, String> {
    let mut config = read_config(app);
    let mut raw = get_keyring_secret(app, KEYRING_DROPBOX_TOKENS).unwrap_or(None);
    if raw.is_none() {
        if let Some(legacy) = config.dropbox_tokens.clone() {
            if set_keyring_secret(app, KEYRING_DROPBOX_TOKENS, Some(legacy.clone())).is_ok() {
                config.dropbox_tokens = None;
                write_config_files(&get_config_path(app), &get_secrets_path(app), &config)?;
            }
            raw = Some(legacy);
        }
    }
    let Some(raw) = raw else {
        return Ok(None);
    };
    let parsed: DropboxTokenBundle = serde_json::from_str(&raw).map_err(|_| {
        "Stored Dropbox token payload is invalid. Please reconnect Dropbox.".to_string()
    })?;
    if parsed.client_id.trim().is_empty()
        || parsed.access_token.trim().is_empty()
        || parsed.refresh_token.trim().is_empty()
    {
        return Err(
            "Stored Dropbox token payload is invalid. Please reconnect Dropbox.".to_string(),
        );
    }
    Ok(Some(parsed))
}

fn write_dropbox_tokens(app: &tauri::AppHandle, tokens: &DropboxTokenBundle) -> Result<(), String> {
    let payload = serde_json::to_string(tokens)
        .map_err(|error| format!("Failed to serialize Dropbox tokens: {error}"))?;
    let config_path = get_config_path(app);
    let secrets_path = get_secrets_path(app);
    let mut config = read_config(app);
    match set_keyring_secret(app, KEYRING_DROPBOX_TOKENS, Some(payload.clone())) {
        Ok(_) => {
            if config.dropbox_tokens.is_some() {
                config.dropbox_tokens = None;
                write_config_files(&config_path, &secrets_path, &config)?;
            }
            Ok(())
        }
        Err(_error) => {
            config.dropbox_tokens = Some(payload);
            write_config_files(&config_path, &secrets_path, &config)
        }
    }
}

fn clear_dropbox_tokens(app: &tauri::AppHandle) -> Result<(), String> {
    let _ = set_keyring_secret(app, KEYRING_DROPBOX_TOKENS, None);
    let config_path = get_config_path(app);
    let secrets_path = get_secrets_path(app);
    let mut config = read_config(app);
    if config.dropbox_tokens.is_some() {
        config.dropbox_tokens = None;
        write_config_files(&config_path, &secrets_path, &config)?;
    }
    Ok(())
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
    let (access_token, expires_at) = refresh_dropbox_token(&client_id, &tokens.refresh_token)?;
    tokens.access_token = access_token;
    tokens.expires_at = expires_at;
    write_dropbox_tokens(app, &tokens)?;
    Ok(tokens.access_token)
}

fn run_dropbox_oauth(app: &tauri::AppHandle, client_id: &str) -> Result<(), String> {
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
    let tokens =
        exchange_dropbox_auth_code(&normalized_client_id, &code, &verifier, &redirect_uri)?;
    write_dropbox_tokens(app, &tokens)?;
    Ok(())
}

fn bootstrap_storage_layout(app: &tauri::AppHandle) -> Result<(), String> {
    let config_dir = get_config_dir(app);
    let data_dir = get_data_dir(app);
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let legacy_config_path = get_legacy_config_json_path(app);
    let legacy_config: LegacyAppConfigJson =
        if let Ok(content) = fs::read_to_string(&legacy_config_path) {
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            LegacyAppConfigJson::default()
        };

    let config_path = get_config_path(app);
    if !config_path.exists() {
        let config = AppConfigToml {
            sync_path: legacy_config.sync_path.clone(),
            ..AppConfigToml::default()
        };
        write_config_files(&config_path, &get_secrets_path(app), &config)?;
    }

    let data_path = get_data_path(app);
    if !data_path.exists() {
        if let Some(custom_path) = legacy_config.data_file_path.as_ref() {
            let custom_path = PathBuf::from(custom_path);
            if custom_path.exists() {
                fs::copy(&custom_path, &data_path).map_err(|e| e.to_string())?;
                return Ok(());
            }
        }

        let legacy_config_data_path = config_dir.join(DATA_FILE_NAME);
        if legacy_config_data_path.exists() {
            fs::copy(&legacy_config_data_path, &data_path).map_err(|e| e.to_string())?;
            return Ok(());
        }

        let legacy_data_path = get_legacy_data_json_path(app);
        if legacy_data_path.exists() {
            fs::copy(&legacy_data_path, &data_path).map_err(|e| e.to_string())?;
            return Ok(());
        }

        let initial_data = serde_json::json!({
            "tasks": [],
            "projects": [],
            "settings": {}
        });
        fs::write(
            &data_path,
            serde_json::to_string_pretty(&initial_data).unwrap(),
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn ensure_data_file(app: &tauri::AppHandle) -> Result<(), String> {
    bootstrap_storage_layout(app)
}

#[tauri::command]
async fn get_data(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_data_file(&app)?;
        let data_path = get_data_path(&app);
        let backup_path = data_path.with_extension("json.bak");
        let mut conn = open_sqlite(&app)?;

        if !sqlite_has_any_data(&conn)? && data_path.exists() {
            if let Ok(value) = read_json_with_retries(&data_path, 2) {
                let _ = fs::copy(&data_path, &backup_path);
                migrate_json_to_sqlite(&mut conn, &value)?;
                ensure_fts_populated(&conn, true)?;
            }
        }

        match read_sqlite_data(&conn) {
            Ok(mut value) => {
                let settings_empty = value
                    .get("settings")
                    .and_then(|v| v.as_object())
                    .map(|obj| obj.is_empty())
                    .unwrap_or(true);
                if settings_empty && data_path.exists() {
                    if let Ok(json_value) = read_json_with_retries(&data_path, 2) {
                        if let Some(json_settings) =
                            json_value.get("settings").and_then(|v| v.as_object())
                        {
                            if !json_settings.is_empty() {
                                if let Some(map) = value.as_object_mut() {
                                    map.insert(
                                        "settings".to_string(),
                                        Value::Object(json_settings.clone()),
                                    );
                                }
                            }
                        }
                    }
                }
                Ok(value)
            }
            Err(primary_err) => {
                if data_path.exists() {
                    if let Ok(value) = read_json_with_retries(&data_path, 2) {
                        return Ok(value);
                    }
                }
                if backup_path.exists() {
                    if let Ok(value) = read_json_with_retries(&backup_path, 2) {
                        return Ok(value);
                    }
                }
                Err(primary_err)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_data_json(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_path = get_data_path(&app);
        read_json_with_retries(&data_path, 2).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_data(app: tauri::AppHandle, data: Value) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        persist_data_snapshot_with_retries(&app, &data)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn get_snapshot_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_path = get_data_path(app);
    let parent = data_path
        .parent()
        .ok_or_else(|| "Failed to resolve data directory for snapshots".to_string())?;
    Ok(parent.join(SNAPSHOT_DIR_NAME))
}

fn is_snapshot_file_name(name: &str) -> bool {
    name.starts_with("data.") && name.ends_with(".snapshot.json")
}

fn format_snapshot_file_name(now: OffsetDateTime) -> String {
    format!(
        "data.{:04}-{:02}-{:02}T{:02}-{:02}-{:02}.snapshot.json",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

fn list_snapshot_entries(snapshot_dir: &Path) -> Vec<(String, PathBuf, SystemTime)> {
    let mut entries: Vec<(String, PathBuf, SystemTime)> = Vec::new();
    let Ok(read_dir) = fs::read_dir(snapshot_dir) else {
        return entries;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !is_snapshot_file_name(name) {
            continue;
        }
        let modified = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);
        entries.push((name.to_string(), path, modified));
    }
    entries.sort_by(|a, b| b.2.cmp(&a.2));
    entries
}

fn prune_data_snapshots(snapshot_dir: &Path) {
    let now = SystemTime::now();
    let max_age_secs = SNAPSHOT_RETENTION_MAX_AGE_SECS;
    let entries = list_snapshot_entries(snapshot_dir);

    let mut fresh: Vec<(String, PathBuf, u64)> = Vec::new();
    for (name, path, modified) in entries {
        let age_secs = now
            .duration_since(modified)
            .unwrap_or(Duration::from_secs(0))
            .as_secs();
        if age_secs > max_age_secs {
            let _ = fs::remove_file(&path);
            continue;
        }
        fresh.push((name, path, age_secs));
    }

    if fresh.len() <= SNAPSHOT_RETENTION_MAX_COUNT {
        return;
    }

    // Strategy: keep the latest few snapshots, then spread remaining slots across
    // the retention window so snapshots represent different points in time.
    let recent_keep = SNAPSHOT_RETENTION_RECENT_COUNT
        .min(SNAPSHOT_RETENTION_MAX_COUNT)
        .min(fresh.len());
    let mut keep = vec![false; fresh.len()];
    let mut kept_count = 0usize;
    for flag in keep.iter_mut().take(recent_keep) {
        *flag = true;
        kept_count += 1;
    }

    let extra_slots = SNAPSHOT_RETENTION_MAX_COUNT.saturating_sub(recent_keep);
    if extra_slots > 0 {
        for slot in 1..=extra_slots {
            let target_age = (slot as u64 * max_age_secs) / (extra_slots as u64);
            let mut best_index: Option<usize> = None;
            let mut best_distance = u64::MAX;
            for (index, (_, _, age_secs)) in fresh.iter().enumerate() {
                if keep[index] {
                    continue;
                }
                let distance = age_secs.abs_diff(target_age);
                if distance < best_distance {
                    best_distance = distance;
                    best_index = Some(index);
                }
            }
            if let Some(index) = best_index {
                keep[index] = true;
                kept_count += 1;
            }
        }
    }

    // If selection is still short (sparse history), fill from the oldest entries.
    if kept_count < SNAPSHOT_RETENTION_MAX_COUNT {
        for index in (0..fresh.len()).rev() {
            if keep[index] {
                continue;
            }
            keep[index] = true;
            kept_count += 1;
            if kept_count >= SNAPSHOT_RETENTION_MAX_COUNT {
                break;
            }
        }
    }

    for (index, (_, path, _)) in fresh.into_iter().enumerate() {
        if !keep[index] {
            let _ = fs::remove_file(&path);
        }
    }
}

fn files_are_identical(left: &Path, right: &Path) -> bool {
    let left_meta = match fs::metadata(left) {
        Ok(meta) => meta,
        Err(_) => return false,
    };
    let right_meta = match fs::metadata(right) {
        Ok(meta) => meta,
        Err(_) => return false,
    };
    if left_meta.len() != right_meta.len() {
        return false;
    }
    match (fs::read(left), fs::read(right)) {
        (Ok(left_bytes), Ok(right_bytes)) => left_bytes == right_bytes,
        _ => false,
    }
}

#[tauri::command]
fn create_data_snapshot(app: tauri::AppHandle) -> Result<String, String> {
    ensure_data_file(&app)?;
    let data_path = get_data_path(&app);
    if !data_path.exists() {
        return Err("Local data file not found".to_string());
    }
    let snapshot_dir = get_snapshot_dir(&app)?;
    fs::create_dir_all(&snapshot_dir).map_err(|e| e.to_string())?;
    if let Some((latest_name, latest_path, _)) = list_snapshot_entries(&snapshot_dir).first() {
        if files_are_identical(&data_path, latest_path) {
            prune_data_snapshots(&snapshot_dir);
            return Ok(latest_name.clone());
        }
    }
    let now = OffsetDateTime::now_utc();
    let file_name = format_snapshot_file_name(now);
    let snapshot_path = snapshot_dir.join(&file_name);
    fs::copy(&data_path, &snapshot_path).map_err(|e| e.to_string())?;
    prune_data_snapshots(&snapshot_dir);
    Ok(file_name)
}

#[tauri::command]
fn list_data_snapshots(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    ensure_data_file(&app)?;
    let snapshot_dir = get_snapshot_dir(&app)?;
    if !snapshot_dir.exists() {
        return Ok(Vec::new());
    }
    prune_data_snapshots(&snapshot_dir);
    let names = list_snapshot_entries(&snapshot_dir)
        .into_iter()
        .map(|(name, _, _)| name)
        .collect();
    Ok(names)
}

#[tauri::command]
fn restore_data_snapshot(
    app: tauri::AppHandle,
    snapshot_file_name: String,
) -> Result<bool, String> {
    ensure_data_file(&app)?;
    let trimmed = snapshot_file_name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Invalid snapshot file name".to_string());
    }
    if !is_snapshot_file_name(trimmed) {
        return Err("Invalid snapshot file format".to_string());
    }
    let snapshot_dir = get_snapshot_dir(&app)?;
    let snapshot_path = snapshot_dir.join(trimmed);
    if !snapshot_path.exists() {
        return Err("Snapshot file not found".to_string());
    }

    let data = read_json_with_retries(&snapshot_path, 2)?;
    persist_data_snapshot_with_retries(&app, &data)?;
    Ok(true)
}

#[tauri::command]
fn query_tasks(app: tauri::AppHandle, options: TaskQueryOptions) -> Result<Vec<Value>, String> {
    let conn = open_sqlite(&app)?;
    let mut where_clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    let include_deleted = options.include_deleted.unwrap_or(false);
    let include_archived = options.include_archived.unwrap_or(false);

    if !include_deleted {
        where_clauses.push("deletedAt IS NULL".to_string());
    }
    if !include_archived {
        where_clauses.push("status != 'archived'".to_string());
    }

    if let Some(status) = options.status.as_ref() {
        if status != "all" {
            where_clauses.push("status = ?".to_string());
            params.push(Box::new(status.clone()));
        }
    }

    if let Some(exclude_statuses) = options.exclude_statuses.as_ref() {
        if !exclude_statuses.is_empty() {
            let placeholders = vec!["?"; exclude_statuses.len()].join(", ");
            where_clauses.push(format!("status NOT IN ({})", placeholders));
            for status in exclude_statuses {
                params.push(Box::new(status.clone()));
            }
        }
    }

    if let Some(project_id) = options.project_id.as_ref() {
        where_clauses.push("projectId = ?".to_string());
        params.push(Box::new(project_id.clone()));
    }

    let sql = if where_clauses.is_empty() {
        "SELECT * FROM tasks".to_string()
    } else {
        format!("SELECT * FROM tasks WHERE {}", where_clauses.join(" AND "))
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(params.iter().map(|p| p.as_ref())), |row| {
            row_to_task_value(row)
        })
        .map_err(|e| e.to_string())?;

    let mut tasks: Vec<Value> = Vec::new();
    for row in rows {
        tasks.push(row.map_err(|e| e.to_string())?);
    }
    Ok(tasks)
}

#[tauri::command]
fn search_fts(app: tauri::AppHandle, query: String) -> Result<Value, String> {
    let conn = open_sqlite(&app)?;
    let Some(fts_query) = build_fts_query(&query) else {
        return Ok(serde_json::json!({ "tasks": [], "projects": [] }));
    };

    let mut tasks: Vec<Value> = Vec::new();
    let mut projects: Vec<Value> = Vec::new();

    let mut task_stmt = conn
        .prepare("SELECT t.* FROM tasks_fts f JOIN tasks t ON f.id = t.id WHERE tasks_fts MATCH ? AND t.deletedAt IS NULL")
        .map_err(|e| e.to_string())?;
    let task_rows = task_stmt
        .query_map([fts_query.clone()], |row| row_to_task_value(row))
        .map_err(|e| e.to_string())?;
    for row in task_rows {
        tasks.push(row.map_err(|e| e.to_string())?);
    }

    let mut project_stmt = conn
        .prepare("SELECT p.* FROM projects_fts f JOIN projects p ON f.id = p.id WHERE projects_fts MATCH ? AND p.deletedAt IS NULL")
        .map_err(|e| e.to_string())?;
    let project_rows = project_stmt
        .query_map([fts_query], |row| row_to_project_value(row))
        .map_err(|e| e.to_string())?;
    for row in project_rows {
        projects.push(row.map_err(|e| e.to_string())?);
    }

    Ok(serde_json::json!({
        "tasks": tasks,
        "projects": projects
    }))
}

#[tauri::command]
fn get_data_path_cmd(app: tauri::AppHandle) -> String {
    get_data_path(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn get_db_path_cmd(app: tauri::AppHandle) -> String {
    get_db_path(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn get_config_path_cmd(app: tauri::AppHandle) -> String {
    get_config_path(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn get_ai_key(app: tauri::AppHandle, provider: String) -> Option<String> {
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

#[tauri::command]
fn set_ai_key(
    app: tauri::AppHandle,
    provider: String,
    value: Option<String>,
) -> Result<(), String> {
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
            match provider.as_str() {
                "openai" => config.ai_key_openai = next_value,
                "anthropic" => config.ai_key_anthropic = next_value,
                "gemini" => config.ai_key_gemini = next_value,
                _ => {}
            }
            write_config_files(&get_config_path(&app), &get_secrets_path(&app), &config)
        }
    }
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

    let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Sync path must not be a symlink".to_string());
    }
    if !metadata.is_dir() {
        return Err("Sync path must be a directory".to_string());
    }

    Ok(canonical)
}

fn resolve_sync_dir(app: &tauri::AppHandle, path: Option<String>) -> Result<PathBuf, String> {
    let candidate = match path {
        Some(raw) => normalize_sync_dir(raw.trim()),
        None => default_sync_dir(app)?,
    };
    validate_sync_dir(&candidate)
}

// ---------------------------------------------------------------------------
// macOS sandbox: security-scoped bookmark helpers
// ---------------------------------------------------------------------------

/// Create a security-scoped bookmark for `path` so the sandbox remembers
/// access across app launches.  Returns the base64-encoded bookmark data,
/// or `None` when not running on macOS or if creation fails.
#[cfg(target_os = "macos")]
fn create_sync_path_bookmark(path: &Path) -> Option<String> {
    let c_path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let raw = unsafe { mindwtr_macos_create_security_bookmark(c_path.as_ptr()) };
    if raw.is_null() {
        log::warn!("Failed to create security-scoped bookmark for {:?}", path);
        return None;
    }
    let result = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .to_string();
    unsafe { mindwtr_macos_free_bookmark_string(raw) };
    log::info!("Created security-scoped bookmark for {:?}", path);
    Some(result)
}

/// Resolve a previously stored bookmark, calling
/// `startAccessingSecurityScopedResource` so the sandbox grants access.
/// Returns the resolved path on success.
#[cfg(target_os = "macos")]
fn resolve_sync_path_bookmark(base64: &str) -> Option<PathBuf> {
    let c_b64 = CString::new(base64).ok()?;
    let raw = unsafe { mindwtr_macos_resolve_security_bookmark(c_b64.as_ptr()) };
    if raw.is_null() {
        log::warn!("Failed to resolve security-scoped bookmark");
        return None;
    }
    let resolved = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .to_string();
    unsafe { mindwtr_macos_free_bookmark_string(raw) };
    log::info!("Resolved security-scoped bookmark → {resolved}");
    Some(PathBuf::from(resolved))
}

/// Add `dir` (and everything beneath it) to the Tauri runtime fs scope so
/// the TypeScript frontend can use `@tauri-apps/plugin-fs` operations on it.
fn expand_tauri_fs_scope(app: &tauri::AppHandle, dir: &Path) {
    if let Err(error) = app.fs_scope().allow_directory(dir, true) {
        log::warn!(
            "Failed to expand Tauri fs scope for {:?}: {error}",
            dir
        );
    } else {
        log::info!("Expanded Tauri fs scope to include {:?}", dir);
    }
}

#[tauri::command]
fn get_sync_path(app: tauri::AppHandle) -> Result<String, String> {
    let config = read_config(&app);
    let Some(sync_path) = config
        .sync_path
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return Ok(String::new());
    };
    let path = resolve_sync_dir(&app, Some(sync_path.to_string()))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn set_sync_path(app: tauri::AppHandle, sync_path: String) -> Result<serde_json::Value, String> {
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

    // Create a security-scoped bookmark so the sandbox remembers this path.
    #[cfg(target_os = "macos")]
    let bookmark = create_sync_path_bookmark(&sanitized_path);

    let mut config = read_config(&app);
    config.sync_path = Some(sanitized_path.to_string_lossy().to_string());
    #[cfg(target_os = "macos")]
    {
        config.sync_path_bookmark = bookmark;
    }
    write_config_files(&config_path, &get_secrets_path(&app), &config)?;

    // Expand the Tauri fs scope so the frontend can watch / read / write here.
    expand_tauri_fs_scope(&app, &sanitized_path);

    Ok(serde_json::json!({
        "success": true,
        "path": config.sync_path,
        "icloud": icloud
    }))
}

fn normalize_backend(value: &str) -> Option<&str> {
    match value {
        "off" | "file" | "webdav" | "cloud" | "cloudkit" => Some(value),
        _ => None,
    }
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

#[tauri::command]
fn get_sync_backend(app: tauri::AppHandle) -> Result<String, String> {
    let config = read_config(&app);
    let raw = config.sync_backend.unwrap_or_else(|| "off".to_string());
    Ok(normalize_backend(raw.trim()).unwrap_or("off").to_string())
}

#[tauri::command]
fn set_sync_backend(app: tauri::AppHandle, backend: String) -> Result<bool, String> {
    let Some(normalized) = normalize_backend(backend.trim()) else {
        return Err("Invalid sync backend".to_string());
    };
    let config_path = get_config_path(&app);
    let mut config = read_config(&app);
    config.sync_backend = Some(normalized.to_string());
    write_config_files(&config_path, &get_secrets_path(&app), &config)?;
    Ok(true)
}

#[tauri::command]
fn get_obsidian_config(app: tauri::AppHandle) -> Result<Value, String> {
    let config = read_config(&app);
    serde_json::to_value(read_obsidian_config_payload(&config)).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_obsidian_config(app: tauri::AppHandle, config: Value) -> Result<Value, String> {
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
    serde_json::to_value(payload).map_err(|e| e.to_string())
}

#[tauri::command]
fn check_obsidian_vault_marker(vault_path: String) -> Result<bool, String> {
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

#[tauri::command]
fn get_webdav_config(app: tauri::AppHandle) -> Result<Value, String> {
    let mut config = read_config(&app);
    let mut password = match get_keyring_secret(&app, KEYRING_WEB_DAV_PASSWORD) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("Failed to read WebDAV password from keyring: {error}");
            None
        }
    };
    if password.is_none() {
        if let Some(legacy) = config.webdav_password.clone() {
            if set_keyring_secret(&app, KEYRING_WEB_DAV_PASSWORD, Some(legacy.clone())).is_ok() {
                config.webdav_password = None;
                write_config_files(&get_config_path(&app), &get_secrets_path(&app), &config)?;
            }
            password = Some(legacy);
        }
    }
    Ok(serde_json::json!({
        "url": config.webdav_url.unwrap_or_default(),
        "username": config.webdav_username.unwrap_or_default(),
        "hasPassword": password.is_some()
    }))
}

#[tauri::command]
fn set_webdav_config(
    app: tauri::AppHandle,
    url: String,
    username: String,
    password: String,
) -> Result<bool, String> {
    let url = url.trim().to_string();
    let config_path = get_config_path(&app);
    let mut config = read_config(&app);

    if url.is_empty() {
        config.webdav_url = None;
        config.webdav_username = None;
        config.webdav_password = None;
        let _ = set_keyring_secret(&app, KEYRING_WEB_DAV_PASSWORD, None);
    } else {
        config.webdav_url = Some(url);
        config.webdav_username = Some(username.trim().to_string());
        if !password.trim().is_empty() {
            let next_password = password.trim().to_string();
            match set_keyring_secret(&app, KEYRING_WEB_DAV_PASSWORD, Some(next_password.clone())) {
                Ok(_) => {
                    config.webdav_password = None;
                }
                Err(_) => {
                    config.webdav_password = Some(next_password);
                }
            }
        }
    }

    write_config_files(&config_path, &get_secrets_path(&app), &config)?;
    Ok(true)
}

fn normalize_webdav_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.to_lowercase().ends_with(".json") {
        trimmed.to_string()
    } else {
        format!("{}/{}", trimmed, DATA_FILE_NAME)
    }
}

fn webdav_get_json_blocking(app: &tauri::AppHandle) -> Result<Value, String> {
    let config = read_config(app);
    let url = normalize_webdav_url(&config.webdav_url.unwrap_or_default());
    if url.trim().is_empty() {
        return Err("WebDAV URL not configured".to_string());
    }
    let username = config.webdav_username.unwrap_or_default();
    let password = match get_keyring_secret(app, KEYRING_WEB_DAV_PASSWORD) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("Failed to read WebDAV password from keyring (GET): {error}");
            None
        }
    }
    .or(config.webdav_password.clone())
    .ok_or_else(|| "WebDAV password not configured".to_string())?;

    let client = reqwest::blocking::Client::new();
    let response = client
        .get(url)
        .basic_auth(username, Some(password))
        .send()
        .map_err(|e| format!("WebDAV request failed: {e}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Value::Null);
    }

    if !response.status().is_success() {
        return Err(format!("WebDAV error: {}", response.status()));
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
async fn webdav_get_json(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || webdav_get_json_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn webdav_put_json_blocking(app: &tauri::AppHandle, data: &Value) -> Result<bool, String> {
    let config = read_config(app);
    let url = normalize_webdav_url(&config.webdav_url.unwrap_or_default());
    if url.trim().is_empty() {
        return Err("WebDAV URL not configured".to_string());
    }
    let username = config.webdav_username.unwrap_or_default();
    let password = match get_keyring_secret(app, KEYRING_WEB_DAV_PASSWORD) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("Failed to read WebDAV password from keyring (PUT): {error}");
            None
        }
    }
    .or(config.webdav_password.clone())
    .ok_or_else(|| "WebDAV password not configured".to_string())?;

    let payload = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to encode WebDAV payload: {e}"))?;
    let client = reqwest::blocking::Client::new();
    let response = client
        .put(url)
        .basic_auth(username, Some(password))
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .map_err(|e| format!("WebDAV request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("WebDAV error: {}", response.status()));
    }
    Ok(true)
}

#[tauri::command]
async fn webdav_put_json(app: tauri::AppHandle, data: Value) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || webdav_put_json_blocking(&app, &data))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_webdav_password(app: tauri::AppHandle) -> Result<String, String> {
    let config = read_config(&app);
    let password = match get_keyring_secret(&app, KEYRING_WEB_DAV_PASSWORD) {
        Ok(value) => value,
        Err(_) => None,
    }
    .or(config.webdav_password);
    Ok(password.unwrap_or_default())
}

#[tauri::command]
fn get_cloud_config(app: tauri::AppHandle) -> Result<Value, String> {
    let mut config = read_config(&app);
    let mut token = get_keyring_secret(&app, KEYRING_CLOUD_TOKEN)?;
    if token.is_none() {
        if let Some(legacy) = config.cloud_token.clone() {
            set_keyring_secret(&app, KEYRING_CLOUD_TOKEN, Some(legacy.clone()))?;
            config.cloud_token = None;
            write_config_files(&get_config_path(&app), &get_secrets_path(&app), &config)?;
            token = Some(legacy);
        }
    }
    Ok(serde_json::json!({
        "url": config.cloud_url.unwrap_or_default(),
        "token": token.unwrap_or_default()
    }))
}

#[tauri::command]
fn set_cloud_config(app: tauri::AppHandle, url: String, token: String) -> Result<bool, String> {
    let url = url.trim().to_string();
    let config_path = get_config_path(&app);
    let mut config = read_config(&app);

    if url.is_empty() {
        config.cloud_url = None;
        config.cloud_token = None;
        set_keyring_secret(&app, KEYRING_CLOUD_TOKEN, None)?;
    } else {
        config.cloud_url = Some(url);
        config.cloud_token = None;
        set_keyring_secret(&app, KEYRING_CLOUD_TOKEN, Some(token))?;
    }

    write_config_files(&config_path, &get_secrets_path(&app), &config)?;
    Ok(true)
}

#[tauri::command]
fn get_dropbox_redirect_uri() -> String {
    dropbox_redirect_uri()
}

#[tauri::command]
fn is_dropbox_connected(app: tauri::AppHandle, client_id: String) -> Result<bool, String> {
    let normalized_client_id = normalize_dropbox_client_id(&client_id)?;
    match read_dropbox_tokens(&app) {
        Ok(Some(tokens)) => Ok(tokens.client_id == normalized_client_id
            && !tokens.access_token.trim().is_empty()
            && !tokens.refresh_token.trim().is_empty()),
        Ok(None) => Ok(false),
        Err(_error) => {
            let _ = clear_dropbox_tokens(&app);
            Ok(false)
        }
    }
}

#[tauri::command]
async fn connect_dropbox(app: tauri::AppHandle, client_id: String) -> Result<bool, String> {
    let oauth_result =
        tauri::async_runtime::spawn_blocking(move || run_dropbox_oauth(&app, &client_id))
            .await
            .map_err(|error| format!("Dropbox OAuth task failed: {error}"))?;
    oauth_result?;
    Ok(true)
}

#[tauri::command]
async fn get_dropbox_access_token(
    app: tauri::AppHandle,
    client_id: String,
    force_refresh: Option<bool>,
) -> Result<String, String> {
    let should_force_refresh = force_refresh.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        get_valid_dropbox_access_token(&app, &client_id, should_force_refresh)
    })
    .await
    .map_err(|error| format!("Dropbox token task failed: {error}"))?
}

#[tauri::command]
async fn disconnect_dropbox(app: tauri::AppHandle, client_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let normalized_client_id = normalize_dropbox_client_id(&client_id)?;
        if let Ok(Some(tokens)) = read_dropbox_tokens(&app) {
            if tokens.client_id == normalized_client_id && !tokens.access_token.trim().is_empty() {
                let _ = reqwest::blocking::Client::new()
                    .post(DROPBOX_REVOKE_ENDPOINT)
                    .bearer_auth(tokens.access_token)
                    .send();
            }
        }
        clear_dropbox_tokens(&app)?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("Dropbox disconnect task failed: {error}"))??;
    Ok(true)
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

#[tauri::command]
fn get_macos_calendar_permission_status() -> Result<String, String> {
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
async fn request_macos_calendar_permission() -> Result<String, String> {
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
fn get_macos_calendar_events(
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

// ---------------------------------------------------------------------------
// CloudKit bridge — Tauri commands
// ---------------------------------------------------------------------------

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
async fn cloudkit_account_status() -> Result<String, String> {
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
async fn cloudkit_ensure_zone() -> Result<bool, String> {
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
async fn cloudkit_ensure_subscription() -> Result<bool, String> {
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
async fn cloudkit_fetch_all_records(record_type: String) -> Result<Value, String> {
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
async fn cloudkit_fetch_changes(change_token: Option<String>) -> Result<Value, String> {
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
async fn cloudkit_save_records(record_type: String, records_json: String) -> Result<Value, String> {
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
async fn cloudkit_delete_records(record_type: String, record_ids: Vec<String>) -> Result<bool, String> {
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
fn cloudkit_consume_pending_remote_change() -> Result<bool, String> {
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
fn cloudkit_register_for_notifications() -> Result<bool, String> {
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
fn get_external_calendars(
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

#[tauri::command]
fn set_external_calendars(
    app: tauri::AppHandle,
    calendars: Vec<ExternalCalendarSubscription>,
) -> Result<bool, String> {
    let config_path = get_config_path(&app);
    let mut config = read_config(&app);
    let is_valid_calendar_url = |raw: &str| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return false;
        }
        trimmed.starts_with("https://")
            || trimmed.starts_with("http://")
            || trimmed.starts_with("webcal://")
    };
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

#[tauri::command]
fn open_path(path: String) -> Result<bool, String> {
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

// ---------------------------------------------------------------------------
// iCloud Drive helpers
// ---------------------------------------------------------------------------

/// Check if a file has been evicted by iCloud's "Optimize Storage" feature.
/// When macOS evicts a file, it replaces it with a hidden placeholder named
/// `.{original_name}.icloud` (a small binary plist). Reading the placeholder
/// returns garbage, not the user's data, so we must detect and skip it.
fn is_icloud_evicted(path: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    // 1) The file itself might be a placeholder (.icloud extension)
    if let Some(ext) = path.extension() {
        if ext == "icloud" {
            return true;
        }
    }
    // 2) The real file was replaced with a hidden .Name.icloud stub
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) {
        let placeholder_name = format!(".{}.icloud", name);
        let placeholder_path = parent.join(&placeholder_name);
        if placeholder_path.exists() && !path.exists() {
            return true;
        }
        // 3) The file exists but is suspiciously small (< 50 bytes) and the
        //    placeholder stub also exists — iCloud may be mid-download.
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

/// Returns true if the sync directory appears to be inside iCloud Drive.
fn is_icloud_path(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    path_str.contains("Library/Mobile Documents/") || path_str.contains("iCloud")
}

/// Acquire a simple advisory lock file for the duration of a sync read or
/// write. Returns the lock path on success. The caller MUST call
/// `release_sync_lock` when done. If the lock is already held and recent
/// (< 30 seconds old), returns Err so the caller can retry.
fn acquire_sync_lock(sync_dir: &Path) -> Result<PathBuf, String> {
    let lock_path = sync_dir.join(".mindwtr.lock");
    // If a stale lock exists (> 30 seconds), remove it.
    if lock_path.exists() {
        if let Ok(meta) = fs::metadata(&lock_path) {
            if let Ok(modified) = meta.modified() {
                let age = SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or(Duration::ZERO);
                if age < Duration::from_secs(30) {
                    return Err("Sync lock held by another process".to_string());
                }
            }
        }
        let _ = fs::remove_file(&lock_path);
    }
    // Write our PID + timestamp as the lock content for debugging.
    let lock_content = format!(
        "pid={} ts={}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_secs()
    );
    fs::write(&lock_path, lock_content.as_bytes())
        .map_err(|e| format!("Failed to acquire sync lock: {e}"))?;
    Ok(lock_path)
}

fn release_sync_lock(lock_path: &Path) {
    let _ = fs::remove_file(lock_path);
}

#[tauri::command]
fn read_sync_file(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let sync_path_str = get_sync_path(app)?;
    if sync_path_str.trim().is_empty() {
        return Err("Sync path is not configured".to_string());
    }
    let sync_dir = PathBuf::from(&sync_path_str);
    let sync_file = sync_dir.join(DATA_FILE_NAME);
    let backup_file = sync_dir.join(format!("{}.bak", DATA_FILE_NAME));
    let legacy_sync_file = PathBuf::from(&sync_path_str).join(format!("{}-sync.json", APP_NAME));

    // Detect iCloud Drive evicted files before attempting to read.
    let find_seed_backup_file = |dir: &Path| -> Option<PathBuf> {
        let mut latest: Option<(SystemTime, PathBuf)> = None;
        let entries = fs::read_dir(dir).ok()?;
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
            match &latest {
                Some((latest_modified, _)) if &modified <= latest_modified => {}
                _ => latest = Some((modified, path)),
            }
        }
        latest.map(|(_, path)| path)
    };

    let read_seed_or_legacy_file = || -> Option<Result<Value, String>> {
        if legacy_sync_file.exists() {
            let content = fs::read_to_string(&legacy_sync_file).map_err(|e| e.to_string());
            return Some(content.and_then(|text| {
                parse_json_relaxed(&text)
                    .map(normalize_sync_value)
                    .map_err(|e| e.to_string())
            }));
        }
        if let Some(seed_file) = find_seed_backup_file(&sync_dir) {
            let content = fs::read_to_string(&seed_file).map_err(|e| e.to_string());
            return Some(content.and_then(|text| {
                parse_json_relaxed(&text)
                    .map(normalize_sync_value)
                    .map_err(|e| e.to_string())
            }));
        }
        None
    };

    if is_icloud_evicted(&sync_file) {
        let msg = format!(
            "Sync file has been offloaded by iCloud Optimize Storage. \
             Open Finder and navigate to {:?} to trigger a re-download, then try again.",
            sync_dir
        );
        log::warn!("{}", msg);
        if backup_file.exists() {
            if let Ok(value) = read_json_with_retries(&backup_file, 2) {
                return Ok(value);
            }
        }
        if let Some(result) = read_seed_or_legacy_file() {
            return result;
        }
        return Err(msg);
    }

    if !sync_file.exists() {
        if let Some(result) = read_seed_or_legacy_file() {
            return result;
        }
        // Return empty app data structure if file doesn't exist
        return Ok(serde_json::json!({
            "tasks": [],
            "projects": [],
            "areas": [],
            "settings": {}
        }));
    }

    match read_json_with_retries(&sync_file, 5) {
        Ok(value) => Ok(value),
        Err(primary_err) => {
            // Fallback to last known good backup if available.
            if backup_file.exists() {
                if let Ok(value) = read_json_with_retries(&backup_file, 2) {
                    return Ok(value);
                }
            }
            Err(primary_err)
        }
    }
}

#[tauri::command]
fn write_sync_file(app: tauri::AppHandle, data: Value) -> Result<bool, String> {
    let sync_path_str = get_sync_path(app)?;
    if sync_path_str.trim().is_empty() {
        return Err("Sync path is not configured".to_string());
    }
    let sync_dir = PathBuf::from(&sync_path_str);
    let sync_file = sync_dir.join(DATA_FILE_NAME);
    let backup_file = sync_dir.join(format!("{}.bak", DATA_FILE_NAME));
    let tmp_file = sync_dir.join(format!("{}.tmp", DATA_FILE_NAME));

    // Detect iCloud evicted target — writing over a placeholder can corrupt state.
    if is_icloud_evicted(&sync_file) {
        log::warn!(
            "Sync target is iCloud-evicted; writing directly to avoid corrupting placeholder."
        );
    }

    if let Some(parent) = sync_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Acquire advisory lock to coordinate with other Mindwtr instances.
    let lock = acquire_sync_lock(&sync_dir);
    let lock_path = match &lock {
        Ok(path) => Some(path.clone()),
        Err(msg) => {
            log::warn!("Sync lock unavailable, proceeding without lock: {msg}");
            None
        }
    };

    let result = (|| -> Result<bool, String> {
        // Best-effort backup for recovery.
        if sync_file.exists() {
            let _ = fs::copy(&sync_file, &backup_file);
        }

        let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;

        // Atomic-ish write: write to tmp then rename over the target.
        {
            let mut file = File::create(&tmp_file).map_err(|e| e.to_string())?;
            file.write_all(content.as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }

        if cfg!(windows) && sync_file.exists() {
            // Windows doesn't allow renaming over an existing file.
            fs::remove_file(&sync_file).map_err(|e| e.to_string())?;
        }

        // Rename may fail on iCloud Drive or other virtual filesystems.
        // Fall back to a direct write if the atomic rename fails.
        match fs::rename(&tmp_file, &sync_file) {
            Ok(()) => Ok(true),
            Err(rename_err) => {
                log::warn!(
                    "Atomic rename failed ({}), falling back to direct write",
                    rename_err
                );
                // Direct copy as fallback — less safe but avoids total failure.
                match fs::copy(&tmp_file, &sync_file) {
                    Ok(_) => {
                        let _ = fs::remove_file(&tmp_file);
                        Ok(true)
                    }
                    Err(copy_err) => Err(format!(
                        "Sync write failed: rename error: {rename_err}, copy fallback error: {copy_err}"
                    )),
                }
            }
        }
    })();

    // Always release the lock, even on failure.
    if let Some(ref lp) = lock_path {
        release_sync_lock(lp);
    }

    result
}

#[tauri::command]
fn set_tray_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(visible).map_err(|e| e.to_string())
    } else {
        log::warn!("set_tray_visible called but no tray icon exists");
        Ok(())
    }
}

#[tauri::command]
fn set_macos_activation_policy(app: tauri::AppHandle, accessory: bool) -> Result<(), String> {
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

fn sanitize_json_text(raw: &str) -> String {
    // Strip BOM and trailing NULs (can occur with partial writes / filesystem quirks).
    let mut text = raw.trim_start_matches('\u{FEFF}').trim_end().to_string();
    while text.ends_with('\u{0}') {
        text.pop();
    }
    text
}

fn parse_json_relaxed(raw: &str) -> Result<Value, serde_json::Error> {
    let sanitized = sanitize_json_text(raw);
    if sanitized.is_empty() {
        return serde_json::from_str::<Value>("{}");
    }

    // 1) Strict parse (fast path)
    if let Ok(value) = serde_json::from_str::<Value>(&sanitized) {
        return Ok(value);
    }

    // 2) Lenient parse: parse the first JSON value and ignore any trailing bytes.
    // This makes sync resilient to "mid-write" files (e.g., Syncthing replacing data.json).
    let start = sanitized.find(|c| c == '{' || c == '[').unwrap_or(0);
    let mut de = serde_json::Deserializer::from_str(&sanitized[start..]);
    Value::deserialize(&mut de)
}

fn normalize_sync_value(value: Value) -> Value {
    if let Value::Object(mut map) = value {
        if !matches!(map.get("tasks"), Some(Value::Array(_))) {
            map.insert("tasks".to_string(), Value::Array(Vec::new()));
        }
        if !matches!(map.get("projects"), Some(Value::Array(_))) {
            map.insert("projects".to_string(), Value::Array(Vec::new()));
        }
        if !matches!(map.get("areas"), Some(Value::Array(_))) {
            map.insert("areas".to_string(), Value::Array(Vec::new()));
        }
        if !matches!(map.get("settings"), Some(Value::Object(_))) {
            map.insert("settings".to_string(), Value::Object(Map::new()));
        }
        return Value::Object(map);
    }
    serde_json::json!({
        "tasks": [],
        "projects": [],
        "areas": [],
        "settings": {}
    })
}

fn read_json_with_retries(path: &Path, attempts: usize) -> Result<Value, String> {
    let mut last_err: Option<String> = None;
    for attempt in 0..attempts {
        // Re-check for iCloud eviction on each retry — the file may have been
        // evicted between attempts if Optimize Storage kicked in.
        if is_icloud_evicted(path) {
            last_err = Some("File is iCloud-evicted (placeholder only)".to_string());
            if attempt + 1 < attempts {
                std::thread::sleep(Duration::from_millis(500));
            }
            continue;
        }

        match fs::read_to_string(path) {
            Ok(content) => match parse_json_relaxed(&content) {
                Ok(value) => return Ok(normalize_sync_value(value)),
                Err(e) => last_err = Some(e.to_string()),
            },
            Err(e) => last_err = Some(e.to_string()),
        }

        // Small backoff to allow other writers (Syncthing/iCloud) to finish replacing the file.
        if attempt + 1 < attempts {
            std::thread::sleep(Duration::from_millis(120 + (attempt as u64) * 80));
        }
    }
    Err(last_err.unwrap_or_else(|| "Failed to read sync file".to_string()))
}

fn is_niri_session() -> bool {
    if env::var("NIRI_SOCKET").is_ok() {
        return true;
    }
    if let Ok(desktop) = env::var("XDG_CURRENT_DESKTOP") {
        return desktop.to_lowercase().contains("niri");
    }
    if let Ok(session) = env::var("XDG_SESSION_DESKTOP") {
        return session.to_lowercase().contains("niri");
    }
    false
}

fn flatpak_install_channel() -> Option<String> {
    let contents = fs::read_to_string("/.flatpak-info").ok()?;
    let mut in_instance = false;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_instance = trimmed.eq_ignore_ascii_case("[Instance]");
            continue;
        }
        if !in_instance {
            continue;
        }
        if let Some(branch) = trimmed.strip_prefix("branch=") {
            let value = branch.trim().to_lowercase();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn is_flatpak() -> bool {
    env::var("FLATPAK_ID").is_ok() || env::var("FLATPAK_SANDBOX_DIR").is_ok()
}

fn diagnostics_enabled() -> bool {
    match env::var("MINDWTR_DIAGNOSTICS") {
        Ok(value) => matches!(value.to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        Err(_) => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(QuickAddPending(AtomicBool::new(false)))
        .manage(CloseRequestHandled(AtomicBool::new(false)))
        .manage(GlobalQuickAddShortcutState(Mutex::new(None)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
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
                window
                    .app_handle()
                    .state::<CloseRequestHandled>()
                    .0
                    .store(false, Ordering::SeqCst);
                let emit_ok = window.emit("close-requested", ()).is_ok();
                if !emit_ok {
                    // Frontend not responding — hide the window as a fallback so the
                    // user isn't stuck with an unresponsive close button.
                    let _ = window.set_skip_taskbar(true);
                    let _ = window.hide();
                } else {
                    // Schedule a safety-net timeout: if the frontend hasn't hidden or
                    // closed the window within 5 seconds, hide it automatically.
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
                        if let Some(w) = handle.get_webview_window("main") {
                            if w.is_visible().unwrap_or(true) {
                                let _ = w.set_skip_taskbar(true);
                                let _ = w.hide();
                            }
                        }
                    });
                }
            }
        })
        .setup(|app| {
            // Ensure data file exists on startup
            ensure_data_file(&app.handle()).ok();

            // On macOS, restore security-scoped bookmarks so the sandbox
            // permits access to the user-selected sync folder, then expand the
            // Tauri fs scope.  On other platforms just expand the scope directly.
            {
                let config = read_config(&app.handle());

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
            }

            let diagnostics_enabled = diagnostics_enabled();
            let is_windows_store = is_windows_store_install();
            if let Some(window) = app.get_webview_window("main") {
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
                if cfg!(target_os = "linux") && is_flatpak() {
                    let _ = window.eval("window.__MINDWTR_FLATPAK__ = true;");
                }
            }

            let handle = app.handle();
            if !(cfg!(target_os = "linux") && is_flatpak()) && !is_windows_store {
                // Build system tray with Quick Add entry. Never hard-fail startup here.
                let tray_init_result: tauri::Result<()> = (|| {
                    let quick_add_item =
                        MenuItem::with_id(handle, "quick_add", "Quick Add", true, None::<&str>)?;
                    let show_item =
                        MenuItem::with_id(handle, "show", "Show Mindwtr", true, None::<&str>)?;
                    let quit_item = MenuItem::with_id(handle, "quit", "Quit", true, None::<&str>)?;
                    let tray_menu =
                        Menu::with_items(handle, &[&quick_add_item, &show_item, &quit_item])?;

                    let tray_icon = Image::from_bytes(include_bytes!("../icons/tray.png"))
                        .ok()
                        .or_else(|| handle.default_window_icon().cloned());

                    if let Some(tray_icon) = tray_icon {
                        let _ = TrayIconBuilder::with_id("main")
                            .icon(tray_icon)
                            .menu(&tray_menu)
                            .show_menu_on_left_click(false)
                            .on_menu_event(move |app, event| match event.id().as_ref() {
                                "quick_add" => {
                                    show_main_and_emit(app);
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
                }
            } else if is_windows_store {
                log::info!("Tray disabled for Microsoft Store install.");
            } else {
                log::info!("Tray disabled inside Flatpak sandbox.");
            }

            // Global hotkey for Quick Add.
            let shortcut_state = app.state::<GlobalQuickAddShortcutState>();
            if let Err(error) = apply_global_quick_add_shortcut(
                &handle,
                &shortcut_state,
                Some(default_global_quick_add_shortcut()),
            ) {
                log::warn!("Failed to register global quick add shortcut: {error}");
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
        .manage(AudioRecorderState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_data,
            read_data_json,
            save_data,
            create_data_snapshot,
            list_data_snapshots,
            restore_data_snapshot,
            query_tasks,
            search_fts,
            get_data_path_cmd,
            get_db_path_cmd,
            get_config_path_cmd,
            acknowledge_close_request,
            get_ai_key,
            set_ai_key,
            get_sync_path,
            set_sync_path,
            get_sync_backend,
            set_sync_backend,
            get_obsidian_config,
            set_obsidian_config,
            check_obsidian_vault_marker,
            get_webdav_config,
            get_webdav_password,
            set_webdav_config,
            webdav_get_json,
            webdav_put_json,
            get_cloud_config,
            set_cloud_config,
            get_dropbox_redirect_uri,
            is_dropbox_connected,
            connect_dropbox,
            get_dropbox_access_token,
            disconnect_dropbox,
            get_external_calendars,
            set_external_calendars,
            get_macos_calendar_permission_status,
            request_macos_calendar_permission,
            get_macos_calendar_events,
            cloudkit_account_status,
            cloudkit_ensure_zone,
            cloudkit_ensure_subscription,
            cloudkit_fetch_all_records,
            cloudkit_fetch_changes,
            cloudkit_save_records,
            cloudkit_delete_records,
            cloudkit_consume_pending_remote_change,
            cloudkit_register_for_notifications,
            open_path,
            read_sync_file,
            write_sync_file,
            set_tray_visible,
            set_macos_activation_policy,
            get_linux_distro,
            start_audio_recording,
            stop_audio_recording,
            transcribe_whisper,
            log_ai_debug,
            append_log_line,
            clear_log_file,
            consume_quick_add_pending,
            set_global_quick_add_shortcut,
            is_windows_store_install,
            get_install_source,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_main_and_emit(app: &tauri::AppHandle) {
    show_main(app);
    app.state::<QuickAddPending>()
        .0
        .store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("quick-add", ());
    } else {
        let _ = app.emit("quick-add", ());
    }
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
        std::env::temp_dir().join(format!(
            "mindwtr-{name}-{}-{nanos}",
            std::process::id()
        ))
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
}
