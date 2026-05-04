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

mod audio;
mod config;
mod install;
mod logging;
mod obsidian_paths;
mod obsidian_watcher;
mod obsidian_writer;
mod platform;
mod storage;
mod sync;
mod ui;

use audio::{start_audio_recording, stop_audio_recording, transcribe_whisper};
use config::{
    check_obsidian_vault_marker, get_ai_key, get_cloud_config, get_external_calendars,
    get_obsidian_config, get_sync_backend, get_webdav_config, get_webdav_password, set_ai_key,
    set_cloud_config, set_external_calendars, set_obsidian_config, set_sync_backend,
    set_webdav_config,
};
use install::{
    diagnostics_enabled, get_install_source, get_linux_distro, is_flatpak, is_niri_session,
    is_windows_store_install,
};
use logging::{append_log_line, clear_log_file, log_ai_debug};
use obsidian_paths::default_obsidian_inbox_file;
use obsidian_watcher::{start_obsidian_watcher, stop_obsidian_watcher, ObsidianWatcherState};
use obsidian_writer::{
    obsidian_create_task, obsidian_create_tasknotes, obsidian_toggle_task,
    obsidian_toggle_tasknotes,
};
use platform::{
    cloudkit_account_status, cloudkit_consume_pending_remote_change, cloudkit_delete_records,
    cloudkit_ensure_subscription, cloudkit_ensure_zone, cloudkit_fetch_all_records,
    cloudkit_fetch_changes, cloudkit_register_for_notifications, cloudkit_save_records,
    get_macos_calendar_events, get_macos_calendar_permission_status, open_path,
    request_macos_calendar_permission, set_macos_activation_policy,
};
use storage::{
    create_data_snapshot, get_config_path_cmd, get_data, get_data_path_cmd, get_db_path_cmd,
    list_data_snapshots, query_tasks, read_data_json, restore_data_snapshot, save_data, search_fts,
};
use sync::{
    connect_dropbox, disconnect_dropbox, get_dropbox_access_token, get_dropbox_redirect_uri,
    get_sync_path, is_dropbox_connected, read_sync_file, set_sync_path, webdav_get_json,
    webdav_put_json, write_sync_file,
};
use ui::{
    acknowledge_close_request, apply_global_quick_add_shortcut, consume_quick_add_pending,
    create_quick_add_window, quit_app, set_global_quick_add_shortcut, set_tray_visible, show_main,
    show_quick_add_window,
};

#[cfg(test)]
use config::read_config_toml;
pub(crate) use config::{
    get_keyring_secret, parse_toml_string_value, read_config, set_keyring_secret,
    write_config_files,
};
#[cfg(test)]
use install::parse_flatpak_install_channel;
pub(crate) use storage::{
    ensure_data_file, get_config_path, get_data_dir, get_secrets_path, read_json_with_retries,
};
#[cfg(target_os = "macos")]
use sync::resolve_sync_path_bookmark;
pub(crate) use sync::{expand_tauri_fs_scope, is_icloud_evicted};

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
const QUICK_ADD_CLI_FLAG: &str = "--quick-add";
const QUICK_ADD_WINDOW_LABEL: &str = "quick-add";
const QUICK_ADD_WINDOW_URL: &str = "index.html?quickAddWindow=1";
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
  energyLevel TEXT,
  assignedTo TEXT,
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
  dueDate TEXT,
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

    fn mindwtr_cloudkit_account_status() -> *mut c_char;
    fn mindwtr_cloudkit_ensure_zone() -> *mut c_char;
    fn mindwtr_cloudkit_ensure_subscription() -> *mut c_char;
    fn mindwtr_cloudkit_fetch_all_records(record_type: *const c_char) -> *mut c_char;
    fn mindwtr_cloudkit_fetch_changes(change_token_base64: *const c_char) -> *mut c_char;
    fn mindwtr_cloudkit_save_records(
        record_type: *const c_char,
        records_json: *const c_char,
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

fn launch_requests_quick_add<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|arg| arg.as_ref().eq_ignore_ascii_case(QUICK_ADD_CLI_FLAG))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_launch_requests_quick_add = launch_requests_quick_add(env::args());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if launch_requests_quick_add(args.iter()) {
                show_quick_add_window(app);
            } else {
                show_main(app);
            }
        }))
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
                if window.label() == QUICK_ADD_WINDOW_LABEL {
                    let _ = window.hide();
                    return;
                }
                window
                    .app_handle()
                    .state::<CloseRequestHandled>()
                    .0
                    .store(false, Ordering::SeqCst);
                let emit_ok = window.emit("close-requested", ()).is_ok();
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
        .setup(move |app| {
            ensure_data_file(&app.handle()).ok();

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
            if let Err(error) = create_quick_add_window(&handle) {
                log::warn!("{error}");
            }
            if !(cfg!(target_os = "linux") && is_flatpak()) && !is_windows_store {
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
                }
            } else if is_windows_store {
                log::info!("Tray disabled for Microsoft Store install.");
            } else {
                log::info!("Tray disabled inside Flatpak sandbox.");
            }

            let shortcut_state = app.state::<GlobalQuickAddShortcutState>();
            if let Err(error) = apply_global_quick_add_shortcut(
                &handle,
                &shortcut_state,
                Some(default_global_quick_add_shortcut()),
            ) {
                log::warn!("Failed to register global quick add shortcut: {error}");
            }

            if initial_launch_requests_quick_add {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_skip_taskbar(true);
                    let _ = window.hide();
                }
                show_quick_add_window(&handle);
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
        .manage(ObsidianWatcherState::default())
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
}
