use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, ToSql, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::path::BaseDirectory;
use tauri::Manager;
use time::OffsetDateTime;

use crate::config::write_config_files;
use crate::sync::is_icloud_evicted;
use crate::{
    AppConfigToml, LegacyAppConfigJson, APP_NAME, CONFIG_FILE_NAME, DATA_FILE_NAME, DB_FILE_NAME,
    SECRETS_FILE_NAME,
};

const PORTABLE_MARKER_FILE_NAME: &str = "portable.txt";
const PORTABLE_PROFILE_DIR_NAME: &str = "profile";
const PORTABLE_CONFIG_DIR_NAME: &str = "config";
const PORTABLE_DATA_DIR_NAME: &str = "data";
const PORTABLE_WEBVIEW_DIR_NAME: &str = "webview";
const SEARCH_RESULT_LIMIT: usize = 200;
const SEARCH_RESULT_QUERY_LIMIT: i64 = (SEARCH_RESULT_LIMIT as i64) + 1;
const ORPHAN_SECTION_TOMBSTONES_TABLE: &str = "orphan_section_tombstones";
const SNAPSHOT_DIR_NAME: &str = "snapshots";
const SNAPSHOT_RETENTION_MAX_COUNT: usize = 5;
const SNAPSHOT_RETENTION_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;
const SNAPSHOT_RETENTION_RECENT_COUNT: usize = 2;
const SQLITE_BUSY_TIMEOUT_MS: u64 = 5_000;
const STORAGE_RETRY_ATTEMPTS: usize = 4;
const STORAGE_RETRY_BASE_DELAY_MS: u64 = 120;
const STORAGE_SCHEMA_VERSION: i64 = 6;
const STORAGE_SCHEMA_STATE_TABLE: &str = "storage_schema_state";
// Version 4 adds assignedTo to the desktop-native FTS schema and forces one
// content rebuild after the corrected triggers are installed.
const FTS_TRIGGER_MIGRATION_VERSION: i64 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SqliteFileIdentity {
    volume: u64,
    file: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SqliteWarmState {
    storage_version: i64,
    schema_generation: i64,
    file_identity: Option<SqliteFileIdentity>,
}

static SQLITE_WARM_STATES: OnceLock<Mutex<HashMap<PathBuf, SqliteWarmState>>> = OnceLock::new();

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
  relativeStartOffset TEXT,
  dueDate TEXT,
  recurrence TEXT,
  showFutureRecurrence INTEGER,
  pushCount INTEGER,
  tags TEXT,
  contexts TEXT,
  checklist TEXT,
  description TEXT,
  textDirection TEXT,
  attachments TEXT,
  location TEXT,
  projectId TEXT REFERENCES projects(id) ON DELETE SET NULL,
  sectionId TEXT REFERENCES sections(id) ON DELETE SET NULL,
  viewSectionIds TEXT,
  areaId TEXT REFERENCES areas(id) ON DELETE SET NULL,
  orderNum INTEGER,
  boardOrder INTEGER,
  focusOrder INTEGER,
  isFocusedToday INTEGER,
  timeEstimate TEXT,
  timeSpentMinutes INTEGER,
  suppressMindwtrReminders INTEGER,
  repeatReminderMinutes INTEGER,
  reviewAt TEXT,
  completedAt TEXT,
  statusBeforeProjectArchive TEXT,
  completedAtBeforeProjectArchive TEXT,
  isFocusedTodayBeforeProjectArchive INTEGER,
  projectArchivedAt TEXT,
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
  sequentialScope TEXT,
  taskSortBy TEXT,
  isFocused INTEGER,
  supportNotes TEXT,
  attachments TEXT,
  dueDate TEXT,
  reviewAt TEXT,
  areaId TEXT REFERENCES areas(id) ON DELETE SET NULL,
  areaTitle TEXT,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT,
  purgedAt TEXT
);

CREATE TABLE IF NOT EXISTS areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  orderNum INTEGER NOT NULL,
  deletedAt TEXT,
  deletedAtBeforeProjectArchive TEXT,
  projectArchivedAt TEXT,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  orderNum INTEGER,
  isCollapsed INTEGER,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT,
  deletedAtBeforeProjectArchive TEXT,
  projectArchivedAt TEXT
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT,
  referenceLink TEXT,
  rev INTEGER,
  revBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_people_updated_at ON people(updatedAt);
CREATE INDEX IF NOT EXISTS idx_people_deleted_at ON people(deletedAt);
CREATE INDEX IF NOT EXISTS idx_people_updatedAt_rev ON people(updatedAt, rev);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_sync (
  task_id TEXT NOT NULL,
  calendar_event_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  PRIMARY KEY (task_id, platform)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);

CREATE TABLE IF NOT EXISTS storage_schema_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  storage_version INTEGER NOT NULL,
  schema_generation INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  id UNINDEXED,
  title,
  description,
  tags,
  contexts,
  checklist,
  location,
  assignedTo,
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
  INSERT INTO tasks_fts (rowid, title, description, tags, contexts, checklist, location, assignedTo)
  VALUES (new.rowid, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''), coalesce((SELECT group_concat(json_extract(value, '$.title'), ' ') FROM json_each(new.checklist)), ''), coalesce(new.location, ''), coalesce(new.assignedTo, ''));
END;

CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts (tasks_fts, rowid, title, description, tags, contexts, checklist, location, assignedTo)
  VALUES ('delete', old.rowid, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''), coalesce((SELECT group_concat(json_extract(value, '$.title'), ' ') FROM json_each(old.checklist)), ''), coalesce(old.location, ''), coalesce(old.assignedTo, ''));
END;

CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts (tasks_fts, rowid, title, description, tags, contexts, checklist, location, assignedTo)
  VALUES ('delete', old.rowid, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''), coalesce((SELECT group_concat(json_extract(value, '$.title'), ' ') FROM json_each(old.checklist)), ''), coalesce(old.location, ''), coalesce(old.assignedTo, ''));
  INSERT INTO tasks_fts (rowid, title, description, tags, contexts, checklist, location, assignedTo)
  VALUES (new.rowid, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''), coalesce((SELECT group_concat(json_extract(value, '$.title'), ' ') FROM json_each(new.checklist)), ''), coalesce(new.location, ''), coalesce(new.assignedTo, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
  INSERT INTO projects_fts (rowid, title, supportNotes, tagIds, areaTitle)
  VALUES (new.rowid, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
  INSERT INTO projects_fts (projects_fts, rowid, title, supportNotes, tagIds, areaTitle)
  VALUES ('delete', old.rowid, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
  INSERT INTO projects_fts (projects_fts, rowid, title, supportNotes, tagIds, areaTitle)
  VALUES ('delete', old.rowid, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
  INSERT INTO projects_fts (rowid, title, supportNotes, tagIds, areaTitle)
  VALUES (new.rowid, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskQueryOptions {
    status: Option<String>,
    project_id: Option<String>,
    exclude_statuses: Option<Vec<String>>,
    include_deleted: Option<bool>,
    include_archived: Option<bool>,
    is_focused_today: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StorageMode {
    Standard,
    Portable { profile_root: PathBuf },
}

fn portable_profile_root_for_exe_dir(exe_dir: &Path) -> PathBuf {
    exe_dir.join(PORTABLE_PROFILE_DIR_NAME)
}

fn detect_storage_mode_from_exe_dir(exe_dir: Option<&Path>) -> StorageMode {
    let Some(exe_dir) = exe_dir else {
        return StorageMode::Standard;
    };
    let marker_path = exe_dir.join(PORTABLE_MARKER_FILE_NAME);
    if marker_path.exists() {
        return StorageMode::Portable {
            profile_root: portable_profile_root_for_exe_dir(exe_dir),
        };
    }
    StorageMode::Standard
}

fn detect_storage_mode() -> StorageMode {
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    detect_storage_mode_from_exe_dir(exe_dir.as_deref())
}

pub(crate) fn is_portable_mode() -> bool {
    matches!(detect_storage_mode(), StorageMode::Portable { .. })
}

// Keeps the webview's own browsing profile (cache, local storage) inside the
// portable profile instead of the OS-default per-user location.
pub(crate) fn portable_webview_data_dir() -> Option<PathBuf> {
    if let StorageMode::Portable { profile_root } = detect_storage_mode() {
        return Some(profile_root.join(PORTABLE_WEBVIEW_DIR_NAME));
    }
    None
}

/// Removes `path` only when it is an empty directory. Returns whether it went.
///
/// `remove_dir` is non-recursive and fails on a non-empty directory, so this can
/// never take anything with it — if some other component has put a file there,
/// the call simply fails and the directory stays.
fn remove_dir_if_empty(path: &Path) -> bool {
    std::fs::remove_dir(path).is_ok()
}

/// Portable installs are meant to leave nothing outside their own folder, but
/// plugins create the OS config directory whether or not they end up writing
/// anything there (#936). Tauri has no hook to prevent that yet, so the empty
/// leftover is cleared on the way out.
pub(crate) fn cleanup_portable_os_config_dir(app: &tauri::AppHandle) {
    if !is_portable_mode() {
        return;
    }
    let Ok(os_config_dir) = app.path().app_config_dir() else {
        return;
    };
    remove_dir_if_empty(&os_config_dir);
}

pub(crate) fn get_config_dir_for_startup() -> PathBuf {
    if let StorageMode::Portable { profile_root } = detect_storage_mode() {
        return profile_root.join(PORTABLE_CONFIG_DIR_NAME);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_NAME)
}

pub(crate) fn get_config_path_for_startup() -> PathBuf {
    get_config_dir_for_startup().join(CONFIG_FILE_NAME)
}

pub(crate) fn get_config_dir(app: &tauri::AppHandle) -> PathBuf {
    if let StorageMode::Portable { profile_root } = detect_storage_mode() {
        return profile_root.join(PORTABLE_CONFIG_DIR_NAME);
    }
    app.path()
        .resolve(APP_NAME, BaseDirectory::Config)
        .unwrap_or_else(|_| get_config_dir_for_startup())
}

pub(crate) fn get_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if let StorageMode::Portable { profile_root } = detect_storage_mode() {
        return profile_root.join(PORTABLE_DATA_DIR_NAME);
    }
    app.path()
        .resolve(APP_NAME, BaseDirectory::Data)
        .unwrap_or_else(|_| {
            let home = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
            home.join(APP_NAME)
        })
}

pub(crate) fn get_config_path(app: &tauri::AppHandle) -> PathBuf {
    get_config_dir(app).join(CONFIG_FILE_NAME)
}

pub(crate) fn get_secrets_path(app: &tauri::AppHandle) -> PathBuf {
    get_config_dir(app).join(SECRETS_FILE_NAME)
}

pub(crate) fn get_data_path(app: &tauri::AppHandle) -> PathBuf {
    get_data_dir(app).join(DATA_FILE_NAME)
}

pub(crate) fn get_db_path(app: &tauri::AppHandle) -> PathBuf {
    get_data_dir(app).join(DB_FILE_NAME)
}

fn sqlite_schema_generation(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA schema_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn stored_sqlite_schema_state(conn: &Connection) -> Result<Option<SqliteWarmState>, String> {
    if !sqlite_table_exists(conn, STORAGE_SCHEMA_STATE_TABLE)? {
        return Ok(None);
    }
    conn.query_row(
        "SELECT storage_version, schema_generation FROM storage_schema_state WHERE id = 1",
        [],
        |row| {
            Ok(SqliteWarmState {
                storage_version: row.get(0)?,
                schema_generation: row.get(1)?,
                file_identity: None,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn sqlite_schema_state_is_current(
    conn: &Connection,
    schema_generation: i64,
) -> Result<bool, String> {
    Ok(stored_sqlite_schema_state(conn)?.is_some_and(|state| {
        state.storage_version == STORAGE_SCHEMA_VERSION
            && state.schema_generation == schema_generation
    }))
}

fn record_sqlite_schema_state(conn: &Connection, schema_generation: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO storage_schema_state (id, storage_version, schema_generation)
         VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET
           storage_version = excluded.storage_version,
           schema_generation = excluded.schema_generation",
        params![STORAGE_SCHEMA_VERSION, schema_generation],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn initialize_sqlite_schema(conn: &mut Connection) -> Result<i64, String> {
    conn.execute_batch("PRAGMA journal_mode = WAL;")
        .map_err(|e| e.to_string())?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let current_generation = sqlite_schema_generation(&transaction)?;
        if sqlite_schema_state_is_current(&transaction, current_generation)? {
            return Ok(current_generation);
        }

        transaction
            .execute_batch(SQLITE_SCHEMA)
            .map_err(|e| e.to_string())?;
        ensure_orphan_section_tombstones_schema(&transaction)?;
        ensure_column(&transaction, "tasks", "energyLevel", "TEXT")?;
        ensure_column(&transaction, "tasks", "assignedTo", "TEXT")?;
        ensure_column(&transaction, "tasks", "textDirection", "TEXT")?;
        ensure_column(&transaction, "tasks", "relativeStartOffset", "TEXT")?;
        ensure_column(&transaction, "tasks", "showFutureRecurrence", "INTEGER")?;
        ensure_column(&transaction, "tasks", "suppressMindwtrReminders", "INTEGER")?;
        ensure_column(&transaction, "tasks", "repeatReminderMinutes", "INTEGER")?;
        ensure_column(&transaction, "tasks", "timeSpentMinutes", "INTEGER")?;
        ensure_column(&transaction, "tasks", "statusBeforeProjectArchive", "TEXT")?;
        ensure_column(
            &transaction,
            "tasks",
            "completedAtBeforeProjectArchive",
            "TEXT",
        )?;
        ensure_column(
            &transaction,
            "tasks",
            "isFocusedTodayBeforeProjectArchive",
            "INTEGER",
        )?;
        ensure_column(&transaction, "tasks", "projectArchivedAt", "TEXT")?;
        ensure_column(
            &transaction,
            "sections",
            "deletedAtBeforeProjectArchive",
            "TEXT",
        )?;
        ensure_column(&transaction, "sections", "projectArchivedAt", "TEXT")?;
        ensure_column(
            &transaction,
            "areas",
            "deletedAtBeforeProjectArchive",
            "TEXT",
        )?;
        ensure_column(&transaction, "areas", "projectArchivedAt", "TEXT")?;
        ensure_tasks_purged_at_column(&transaction)?;
        ensure_tasks_order_column(&transaction)?;
        ensure_column(&transaction, "tasks", "boardOrder", "INTEGER")?;
        ensure_column(&transaction, "tasks", "focusOrder", "INTEGER")?;
        ensure_tasks_area_column(&transaction)?;
        ensure_tasks_section_column(&transaction)?;
        ensure_column(&transaction, "tasks", "viewSectionIds", "TEXT")?;
        ensure_tasks_organization_indexes(&transaction)?;
        ensure_projects_order_column(&transaction)?;
        ensure_column(&transaction, "projects", "sequentialScope", "TEXT")?;
        ensure_column(&transaction, "projects", "taskSortBy", "TEXT")?;
        ensure_projects_due_date_column(&transaction)?;
        ensure_projects_purged_at_column(&transaction)?;
        ensure_projects_area_order_index(&transaction)?;
        ensure_sync_revision_columns(&transaction)?;
        ensure_fts_ready_in_transaction(&transaction)?;
        ensure_calendar_sync_schema(&transaction)?;

        let schema_generation = sqlite_schema_generation(&transaction)?;
        record_sqlite_schema_state(&transaction, schema_generation)?;
        Ok(schema_generation)
    })();

    match result {
        Ok(schema_generation) => {
            transaction.commit().map_err(|e| e.to_string())?;
            Ok(schema_generation)
        }
        Err(error) => {
            transaction.rollback().map_err(|rollback_error| {
                format!("{error}; schema initialization rollback failed: {rollback_error}")
            })?;
            Err(error)
        }
    }
}

fn configure_sqlite_connection(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
        .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;")
        .map_err(|e| e.to_string())
}

fn resolved_sqlite_path(db_path: &Path) -> PathBuf {
    fs::canonicalize(db_path).unwrap_or_else(|_| db_path.to_path_buf())
}

#[cfg(unix)]
fn sqlite_file_identity(db_path: &Path) -> Option<SqliteFileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(db_path).ok()?;
    Some(SqliteFileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn sqlite_file_identity(db_path: &Path) -> Option<SqliteFileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let file = File::open(db_path).ok()?;
    let mut metadata = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a valid handle for the duration of this call and
    // `metadata` points to writable storage of the exact structure the API
    // expects.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut metadata) } == 0 {
        return None;
    }
    Some(SqliteFileIdentity {
        volume: u64::from(metadata.dwVolumeSerialNumber),
        file: (u64::from(metadata.nFileIndexHigh) << 32) | u64::from(metadata.nFileIndexLow),
    })
}

#[cfg(not(any(unix, windows)))]
fn sqlite_file_identity(_db_path: &Path) -> Option<SqliteFileIdentity> {
    None
}

fn ensure_sqlite_initialized(
    conn: &mut Connection,
    db_path: &Path,
    file_identity: Option<SqliteFileIdentity>,
) -> Result<(), String> {
    let resolved_path = resolved_sqlite_path(db_path);
    let warm_states = SQLITE_WARM_STATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut warm_states = warm_states
        .lock()
        .map_err(|_| "SQLite initialization state lock was poisoned".to_string())?;
    let schema_generation = sqlite_schema_generation(conn)?;
    let warm_state_matches = warm_states.get(&resolved_path).is_some_and(|state| {
        state.storage_version == STORAGE_SCHEMA_VERSION
            && state.schema_generation == schema_generation
            && state.file_identity.is_some()
            && state.file_identity == file_identity
    });
    if warm_state_matches && sqlite_schema_state_is_current(conn, schema_generation)? {
        return Ok(());
    }
    if !warm_state_matches && sqlite_schema_state_is_current(conn, schema_generation)? {
        warm_states.insert(
            resolved_path,
            SqliteWarmState {
                storage_version: STORAGE_SCHEMA_VERSION,
                schema_generation,
                file_identity,
            },
        );
        return Ok(());
    }

    let schema_generation = initialize_sqlite_schema(conn)?;
    warm_states.insert(
        resolved_path,
        SqliteWarmState {
            storage_version: STORAGE_SCHEMA_VERSION,
            schema_generation,
            file_identity,
        },
    );
    Ok(())
}

fn open_sqlite_path(db_path: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let identity_before_open = sqlite_file_identity(db_path);
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let identity_after_open = sqlite_file_identity(db_path);
    let stable_file_identity = if identity_before_open == identity_after_open {
        identity_after_open
    } else {
        None
    };
    configure_sqlite_connection(&conn)?;
    ensure_sqlite_initialized(&mut conn, db_path, stable_file_identity)?;
    Ok(conn)
}

pub(crate) fn open_sqlite(app: &tauri::AppHandle) -> Result<Connection, String> {
    open_sqlite_path(&get_db_path(app))
}

// Sort orders are sparse and may be fractional (midpoints written by older app
// versions or synced from other devices). Binding them as i64 silently turned
// fractional values into NULL, which dropped the task to the bottom of its list
// after the next sync reload (#784). Keep integral values as JSON integers so
// round-trips stay byte-identical for the common case.
fn json_number_from_f64(value: f64) -> Option<Value> {
    if !value.is_finite() {
        return None;
    }
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_992.0 {
        return Some(Value::Number((value as i64).into()));
    }
    serde_json::Number::from_f64(value).map(Value::Number)
}

fn normalize_project_task_sort_by(value: Option<&str>) -> Option<&str> {
    match value {
        Some(value)
            if matches!(
                value,
                "due" | "start" | "review" | "title" | "created" | "created-desc"
            ) =>
        {
            Some(value)
        }
        _ => None,
    }
}

fn is_retryable_storage_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    // "is locked", not "database is locked": SQLite words the same contention
    // three ways — "database is locked" (SQLITE_BUSY with a message), "the
    // database file is locked" (bare SQLITE_BUSY), "a table in the database is
    // locked" (SQLITE_LOCKED) — and the narrower match retried only the first.
    normalized.contains("is locked")
        || normalized.contains("database is busy")
        || normalized.contains("resource busy")
        || normalized.contains("temporarily unavailable")
}

fn data_json_backup_path(data_path: &Path) -> PathBuf {
    data_path.with_extension("json.bak")
}

fn data_json_publication_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

fn lock_data_json_publication() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    data_json_publication_lock()
        .lock()
        .map_err(|error| format!("Failed to lock data.json publication: {error}"))
}

fn snapshot_operation_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

// ponytail: one global lock serializes snapshot create/restore against each
// other now that both run off the main thread (blocking pool, no more
// implicit serialization); per-profile lock if concurrent snapshot ops ever
// become a real workload.
fn lock_snapshot_operation() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    snapshot_operation_lock()
        .lock()
        .map_err(|error| format!("Failed to lock snapshot operation: {error}"))
}

fn sync_parent_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let parent = path
            .parent()
            .ok_or_else(|| "Failed to resolve parent directory".to_string())?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn cleanup_stale_data_json_backup_unlocked(data_path: &Path) -> Result<(), String> {
    cleanup_stale_data_json_backup_for_platform(data_path, cfg!(windows))
}

fn cleanup_stale_data_json_backup_for_platform(
    data_path: &Path,
    use_backup_replacement: bool,
) -> Result<(), String> {
    if !use_backup_replacement {
        return Ok(());
    }
    let backup_path = data_json_backup_path(data_path);
    if !backup_path.exists() {
        return Ok(());
    }
    if data_path.exists() {
        fs::remove_file(&backup_path)
            .map_err(|e| format!("Failed to remove stale backup file: {e}"))?;
        return Ok(());
    }
    fs::rename(&backup_path, data_path)
        .map_err(|e| format!("Failed to restore data file from backup: {e}"))?;
    Ok(())
}

fn replace_data_json_with_backup<R, D>(
    replacement_path: &Path,
    data_path: &Path,
    backup_path: &Path,
    mut rename: R,
    mut remove: D,
) -> Result<(), String>
where
    R: FnMut(&Path, &Path) -> io::Result<()>,
    D: FnMut(&Path) -> io::Result<()>,
{
    rename(data_path, backup_path).map_err(|e| e.to_string())?;
    match rename(replacement_path, data_path) {
        Ok(()) => {
            let _ = remove(backup_path);
            Ok(())
        }
        Err(rename_error) => {
            let restore_error = rename(backup_path, data_path).err();
            match restore_error {
                Some(error) => Err(format!(
                    "Failed to replace data file: {rename_error}; original data kept at {} but restore also failed: {error}",
                    backup_path.display()
                )),
                None => Err(format!("Failed to replace data file: {rename_error}")),
            }
        }
    }
}

fn cleanup_stale_data_json_backup(data_path: &Path) -> Result<(), String> {
    let _publication_guard = lock_data_json_publication()?;
    cleanup_stale_data_json_backup_unlocked(data_path)
}

fn write_data_json_file(data_path: &Path, data: &Value) -> Result<(), String> {
    // Incremental saves publish after releasing SQLite's writer lock. Keep the
    // Windows backup dance and final rename serialized within this process;
    // every writer still uses a unique temp so no publisher can truncate or
    // rename another publisher's in-progress file.
    let _publication_guard = lock_data_json_publication()?;
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    cleanup_stale_data_json_backup_unlocked(data_path)?;
    let backup_path = data_json_backup_path(data_path);
    let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    let parent = data_path
        .parent()
        .ok_or_else(|| "Failed to resolve data.json parent directory".to_string())?;
    let mut temp_file = tempfile::Builder::new()
        .prefix(".mindwtr-data-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| e.to_string())?;
    temp_file
        .write_all(content.as_bytes())
        .and_then(|_| temp_file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    // Close the handle before rename so Windows can move it.
    let temp_path = temp_file.into_temp_path();

    if cfg!(windows) && data_path.exists() {
        replace_data_json_with_backup(
            &temp_path,
            data_path,
            &backup_path,
            |from, to| fs::rename(from, to),
            |path| fs::remove_file(path),
        )?;
        sync_parent_directory(data_path)?;
        return Ok(());
    }

    fs::rename(&temp_path, data_path).map_err(|e| e.to_string())?;
    sync_parent_directory(data_path)?;
    Ok(())
}

fn write_initial_data_json_file(data_path: &Path, data: &Value) -> Result<bool, String> {
    let _publication_guard = lock_data_json_publication()?;
    let parent = data_path
        .parent()
        .ok_or_else(|| "Failed to resolve data.json parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    cleanup_stale_data_json_backup_unlocked(data_path)?;

    if data_path.exists() {
        if read_json_with_retries(data_path, 1).is_ok() {
            return Ok(false);
        }
        // A legacy direct write may have crashed after creating a partial
        // final file. Quarantine it under an unlisted unique temp name for the
        // duration of this publication so mere existence cannot suppress a
        // valid bootstrap retry.
        let quarantine = tempfile::Builder::new()
            .prefix(".mindwtr-invalid-data-")
            .suffix(".tmp")
            .tempfile_in(parent)
            .map_err(|e| e.to_string())?
            .into_temp_path();
        fs::remove_file(&quarantine).map_err(|e| e.to_string())?;
        fs::rename(data_path, &quarantine).map_err(|e| e.to_string())?;
    }

    let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    let mut temp_file = tempfile::Builder::new()
        .prefix(".mindwtr-data-bootstrap-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| e.to_string())?;
    temp_file
        .write_all(content.as_bytes())
        .and_then(|_| temp_file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    match temp_file.persist_noclobber(data_path) {
        Ok(_) => {
            sync_parent_directory(data_path)?;
            Ok(true)
        }
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.error.to_string()),
    }
}

const ENTITY_TABLES: [&str; 5] = ["tasks", "projects", "sections", "areas", "people"];

fn count_incoming_entities(data: &Value) -> usize {
    ENTITY_TABLES
        .iter()
        .map(|key| {
            data.get(*key)
                .and_then(|value| value.as_array())
                .map(|entries| entries.len())
                .unwrap_or(0)
        })
        .sum()
}

fn sqlite_entity_count(conn: &Connection) -> Result<i64, String> {
    let mut total = 0i64;
    for table in ENTITY_TABLES {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?;
        total += count;
    }
    if sqlite_table_exists(conn, ORPHAN_SECTION_TOMBSTONES_TABLE)? {
        total += conn
            .query_row(
                "SELECT COUNT(*) FROM orphan_section_tombstones",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(total)
}

// An unguarded save that would replace existing entities with an all-empty
// document means the caller likely lost its in-memory state (#852). A compacted
// snapshot may legitimately be empty when the caller opts into transactional
// CAS semantics: only explicitly supplied observed rows can then be removed.
fn refuse_empty_snapshot_overwrite(
    conn: &Connection,
    data: &Value,
    baseline_entities: Option<&Value>,
) -> Result<(), String> {
    if count_incoming_entities(data) == 0
        && baseline_entities.is_none()
        && sqlite_entity_count(conn)? > 0
    {
        return Err(
            "Refusing to overwrite existing data with an empty snapshot; local data left untouched"
                .to_string(),
        );
    }
    Ok(())
}

fn persist_data_snapshot(
    app: &tauri::AppHandle,
    data: &Value,
    baseline_entities: Option<&Value>,
) -> Result<Value, String> {
    ensure_data_file(app)?;
    let mut conn = open_sqlite(app)?;
    refuse_empty_snapshot_overwrite(&conn, data, baseline_entities)?;
    let canonical = merge_json_to_sqlite(&mut conn, data, baseline_entities)?;
    // SQLite has committed and is canonical at this point. data.json is a
    // secondary recovery copy: failing to refresh it must not report the
    // already-committed write as failed (a caller retry could duplicate a
    // create). Always derive the copy from SQLite, never the stale caller
    // snapshot that may have lost a revision race above.
    Ok(refresh_data_json_from_sqlite(&conn, &get_data_path(app)).unwrap_or(canonical))
}

fn persist_data_snapshot_exact(app: &tauri::AppHandle, data: &Value) -> Result<Value, String> {
    ensure_data_file(app)?;
    let mut conn = open_sqlite(app)?;
    let canonical = replace_json_in_sqlite(&mut conn, data)?;
    Ok(refresh_data_json_from_sqlite(&conn, &get_data_path(app)).unwrap_or(canonical))
}

fn refresh_data_json_from_sqlite(conn: &Connection, data_path: &Path) -> Option<Value> {
    // SQLite is already committed. Read a transactionally consistent snapshot
    // without taking a second writer lock, then use data_version repair if a
    // later writer commits while pretty JSON serialization/fsync/rename runs.
    match stable_sqlite_snapshot_with_version(conn) {
        Ok((canonical, data_version)) => Some(publish_task_data_json(
            conn,
            data_path,
            canonical,
            data_version,
        )),
        Err(error) => {
            log::warn!(
                "SQLite save committed but canonical data.json snapshot could not be read: {error}"
            );
            None
        }
    }
}

fn write_data_json_best_effort(data_path: &Path, canonical: &Value) {
    if let Err(error) = write_data_json_file(data_path, canonical) {
        log::warn!("SQLite save committed but data.json refresh failed: {error}");
    }
}

fn with_sqlite_read_transaction<T, F>(
    conn: &Connection,
    lock_writers: bool,
    read: F,
) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    conn.execute_batch(if lock_writers {
        "BEGIN IMMEDIATE"
    } else {
        "BEGIN"
    })
    .map_err(|e| e.to_string())?;
    let result = read(conn);
    match result {
        Ok(value) => {
            if let Err(error) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error.to_string());
            }
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn read_sqlite_snapshot(conn: &Connection) -> Result<Value, String> {
    with_sqlite_read_transaction(conn, false, read_sqlite_data)
}

pub(crate) fn persist_data_snapshot_with_retries(
    app: &tauri::AppHandle,
    data: &Value,
    baseline_entities: Option<&Value>,
) -> Result<Value, String> {
    for attempt in 0..STORAGE_RETRY_ATTEMPTS {
        match persist_data_snapshot(app, data, baseline_entities) {
            Ok(canonical) => return Ok(canonical),
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

fn persist_data_snapshot_exact_with_retries(
    app: &tauri::AppHandle,
    data: &Value,
) -> Result<Value, String> {
    for attempt in 0..STORAGE_RETRY_ATTEMPTS {
        match persist_data_snapshot_exact(app, data) {
            Ok(canonical) => return Ok(canonical),
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
    Err("Failed to replace data".to_string())
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

fn sqlite_table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn ensure_orphan_section_tombstones_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS orphan_section_tombstones (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL
        )",
    )
    .map_err(|e| e.to_string())
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

fn ensure_calendar_sync_schema(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS calendar_sync (
          task_id TEXT NOT NULL,
          calendar_event_id TEXT NOT NULL,
          calendar_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          last_synced_at TEXT NOT NULL,
          PRIMARY KEY (task_id, platform)
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
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

fn ensure_tasks_organization_indexes(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_energyLevel ON tasks(energyLevel)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_assignedTo ON tasks(assignedTo)",
        [],
    )
    .map_err(|e| e.to_string())?;
    if has_column(conn, "tasks", "isFocusedToday")? {
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_focus_today ON tasks(isFocusedToday, status, deletedAt)",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
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

fn ensure_projects_due_date_column(conn: &Connection) -> Result<(), String> {
    ensure_column(conn, "projects", "dueDate", "TEXT")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_projects_dueDate ON projects(dueDate)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_projects_purged_at_column(conn: &Connection) -> Result<(), String> {
    ensure_column(conn, "projects", "purgedAt", "TEXT")
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

fn ensure_tasks_fts_schema(conn: &Connection) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(tasks_fts)")
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    let mut has_checklist = false;
    let mut has_assigned_to = false;
    for column in columns {
        match column.map_err(|e| e.to_string())?.as_str() {
            "checklist" => has_checklist = true,
            "assignedTo" => has_assigned_to = true,
            _ => {}
        }
    }
    if has_checklist && has_assigned_to {
        return Ok(false);
    }

    conn.execute("DROP TRIGGER IF EXISTS tasks_ai", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TRIGGER IF EXISTS tasks_ad", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TRIGGER IF EXISTS tasks_au", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TABLE IF EXISTS tasks_fts", [])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
          id UNINDEXED,
          title,
          description,
          tags,
          contexts,
          checklist,
          location,
          assignedTo,
          content=''
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

fn fts_triggers_are_current(conn: &Connection) -> Result<bool, String> {
    for name in [
        "tasks_ai",
        "tasks_ad",
        "tasks_au",
        "projects_ai",
        "projects_ad",
        "projects_au",
    ] {
        let sql = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
                params![name],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(sql) = sql else {
            return Ok(false);
        };
        // Trust the marker only while the actual SQL is still current. An older
        // desktop binary can recreate these triggers without assignedTo while
        // leaving the shared schema_migrations table untouched.
        if name.starts_with("tasks_") && !sql.contains("assignedTo") {
            return Ok(false);
        }
    }
    Ok(true)
}

fn ensure_fts_triggers(conn: &Connection) -> Result<bool, String> {
    let migration_applied = conn
        .query_row(
            "SELECT 1 FROM schema_migrations WHERE version = ?1 LIMIT 1",
            params![FTS_TRIGGER_MIGRATION_VERSION],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if migration_applied && fts_triggers_are_current(conn)? {
        return Ok(false);
    }

    conn.execute("DROP TRIGGER IF EXISTS tasks_ai", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TRIGGER IF EXISTS tasks_ad", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TRIGGER IF EXISTS tasks_au", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TRIGGER IF EXISTS projects_ai", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TRIGGER IF EXISTS projects_ad", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DROP TRIGGER IF EXISTS projects_au", [])
        .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
          INSERT INTO tasks_fts (rowid, title, description, tags, contexts, checklist, location, assignedTo)
          VALUES (new.rowid, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''), coalesce((SELECT group_concat(json_extract(value, '$.title'), ' ') FROM json_each(new.checklist)), ''), coalesce(new.location, ''), coalesce(new.assignedTo, ''));
        END",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
          INSERT INTO tasks_fts (tasks_fts, rowid, title, description, tags, contexts, checklist, location, assignedTo)
          VALUES ('delete', old.rowid, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''), coalesce((SELECT group_concat(json_extract(value, '$.title'), ' ') FROM json_each(old.checklist)), ''), coalesce(old.location, ''), coalesce(old.assignedTo, ''));
        END",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
          INSERT INTO tasks_fts (tasks_fts, rowid, title, description, tags, contexts, checklist, location, assignedTo)
          VALUES ('delete', old.rowid, old.title, coalesce(old.description, ''), coalesce(old.tags, ''), coalesce(old.contexts, ''), coalesce((SELECT group_concat(json_extract(value, '$.title'), ' ') FROM json_each(old.checklist)), ''), coalesce(old.location, ''), coalesce(old.assignedTo, ''));
          INSERT INTO tasks_fts (rowid, title, description, tags, contexts, checklist, location, assignedTo)
          VALUES (new.rowid, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''), coalesce((SELECT group_concat(json_extract(value, '$.title'), ' ') FROM json_each(new.checklist)), ''), coalesce(new.location, ''), coalesce(new.assignedTo, ''));
        END",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
          INSERT INTO projects_fts (rowid, title, supportNotes, tagIds, areaTitle)
          VALUES (new.rowid, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
        END",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
          INSERT INTO projects_fts (projects_fts, rowid, title, supportNotes, tagIds, areaTitle)
          VALUES ('delete', old.rowid, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
        END",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
          INSERT INTO projects_fts (projects_fts, rowid, title, supportNotes, tagIds, areaTitle)
          VALUES ('delete', old.rowid, old.title, coalesce(old.supportNotes, ''), coalesce(old.tagIds, ''), coalesce(old.areaTitle, ''));
          INSERT INTO projects_fts (rowid, title, supportNotes, tagIds, areaTitle)
          VALUES (new.rowid, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
        END",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (version) VALUES (?1)",
        params![FTS_TRIGGER_MIGRATION_VERSION],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
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
    let orphan_section_count = if sqlite_table_exists(conn, ORPHAN_SECTION_TOMBSTONES_TABLE)? {
        conn.query_row(
            "SELECT COUNT(*) FROM orphan_section_tombstones",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
    } else {
        0
    };
    Ok(task_count > 0
        || project_count > 0
        || area_count > 0
        || settings_count > 0
        || orphan_section_count > 0)
}

fn ensure_fts_populated(conn: &Connection, force_rebuild: bool) -> Result<(), String> {
    let tasks_fts_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks_fts", [], |row| row.get(0))
        .unwrap_or(0);
    let missing_tasks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE rowid NOT IN (SELECT rowid FROM tasks_fts)",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let extra_tasks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks_fts WHERE rowid NOT IN (SELECT rowid FROM tasks)",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if force_rebuild || tasks_fts_count == 0 || missing_tasks > 0 || extra_tasks > 0 {
        conn.execute("INSERT INTO tasks_fts(tasks_fts) VALUES('delete-all')", [])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO tasks_fts (rowid, title, description, tags, contexts, checklist, location, assignedTo)
             SELECT rowid, title, coalesce(description, ''), coalesce(tags, ''), coalesce(contexts, ''), coalesce((SELECT group_concat(json_extract(value, '$.title'), ' ') FROM json_each(tasks.checklist)), ''), coalesce(location, ''), coalesce(assignedTo, '') FROM tasks",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    let projects_fts_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM projects_fts", [], |row| row.get(0))
        .unwrap_or(0);
    let missing_projects: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM projects WHERE rowid NOT IN (SELECT rowid FROM projects_fts)",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let extra_projects: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM projects_fts WHERE rowid NOT IN (SELECT rowid FROM projects)",
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
            "INSERT INTO projects_fts (rowid, title, supportNotes, tagIds, areaTitle)
             SELECT rowid, title, coalesce(supportNotes, ''), coalesce(tagIds, ''), coalesce(areaTitle, '') FROM projects",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_fts_ready_in_transaction(conn: &Connection) -> Result<bool, String> {
    let schema_changed = ensure_tasks_fts_schema(conn)?;
    let triggers_changed = ensure_fts_triggers(conn)?;
    ensure_fts_populated(conn, schema_changed || triggers_changed)?;
    Ok(schema_changed || triggers_changed)
}

fn ensure_fts_ready(conn: &mut Connection) -> Result<bool, String> {
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let changed = ensure_fts_ready_in_transaction(&transaction)?;
        if changed && sqlite_table_exists(&transaction, STORAGE_SCHEMA_STATE_TABLE)? {
            let schema_generation = sqlite_schema_generation(&transaction)?;
            record_sqlite_schema_state(&transaction, schema_generation)?;
        }
        Ok(changed)
    })();

    match result {
        Ok(changed) => {
            transaction.commit().map_err(|e| e.to_string())?;
            Ok(changed)
        }
        Err(error) => {
            transaction.rollback().map_err(|rollback_error| {
                format!("{error}; FTS rollback failed: {rollback_error}")
            })?;
            Err(error)
        }
    }
}

fn rebuild_fts_atomically(conn: &mut Connection) -> Result<(), String> {
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    match ensure_fts_populated(&transaction, true) {
        Ok(()) => transaction.commit().map_err(|e| e.to_string()),
        Err(error) => {
            transaction.rollback().map_err(|rollback_error| {
                format!("{error}; FTS rollback failed: {rollback_error}")
            })?;
            Err(error)
        }
    }
}
fn json_str(value: Option<&Value>) -> Option<String> {
    value.and_then(|v| serde_json::to_string(v).ok())
}

fn json_str_or_default(value: Option<&Value>, default: &str) -> String {
    json_str(value).unwrap_or_else(|| default.to_string())
}

fn upsert_task_row(conn: &Connection, task: &Value) -> Result<(), String> {
    upsert_task_row_at(conn, task, OffsetDateTime::now_utc().unix_timestamp_nanos())
}

fn upsert_task_row_at(conn: &Connection, task: &Value, merge_now: i128) -> Result<(), String> {
    let task_id = task
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "Task id is required".to_string())?;
    let current = conn
        .query_row(
            "SELECT * FROM tasks WHERE id = ?1",
            [task_id],
            row_to_task_value,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if current
        .as_ref()
        .is_some_and(|current| !incoming_entity_wins_at(current, task, merge_now))
    {
        return Ok(());
    }
    replace_task_row(conn, task)
}

// Mutations derived from the canonical row while holding BEGIN IMMEDIATE are
// already validated against the only row they can replace. They must bypass
// stale-snapshot arbitration: at a saturated revision, a future-dated old row
// can otherwise defeat a legitimate local patch and turn a 200 response into
// a silent no-op.
fn replace_task_row(conn: &Connection, task: &Value) -> Result<(), String> {
    task.get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "Task id is required".to_string())?;
    let tags_json = json_str_or_default(task.get("tags"), "[]");
    let contexts_json = json_str_or_default(task.get("contexts"), "[]");
    let relative_start_offset_json = json_str(task.get("relativeStartOffset"));
    let recurrence_json = json_str(task.get("recurrence"));
    let checklist_json = json_str(task.get("checklist"));
    let attachments_json = json_str(task.get("attachments"));
    let view_section_ids_json = json_str(task.get("viewSectionIds"));
    let normalized_rev = normalized_revision_for_storage(task.get("rev"));
    let normalized_rev_by = normalized_rev_by(task.get("revBy"));
    conn.execute(
        "INSERT OR REPLACE INTO tasks (id, title, status, priority, energyLevel, assignedTo, taskMode, startTime, relativeStartOffset, dueDate, recurrence, showFutureRecurrence, pushCount, tags, contexts, checklist, description, textDirection, attachments, location, projectId, sectionId, viewSectionIds, areaId, orderNum, boardOrder, focusOrder, isFocusedToday, timeEstimate, suppressMindwtrReminders, repeatReminderMinutes, reviewAt, completedAt, statusBeforeProjectArchive, completedAtBeforeProjectArchive, isFocusedTodayBeforeProjectArchive, projectArchivedAt, rev, revBy, createdAt, updatedAt, deletedAt, purgedAt, timeSpentMinutes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43, ?44)",
        params![
            task.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
            task.get("title").and_then(|v| v.as_str()).unwrap_or_default(),
            task.get("status").and_then(|v| v.as_str()).unwrap_or("inbox"),
            task.get("priority").and_then(|v| v.as_str()),
            task.get("energyLevel").and_then(|v| v.as_str()),
            task.get("assignedTo").and_then(|v| v.as_str()),
            task.get("taskMode").and_then(|v| v.as_str()),
            task.get("startTime").and_then(|v| v.as_str()),
            relative_start_offset_json,
            task.get("dueDate").and_then(|v| v.as_str()),
            recurrence_json,
            task.get("showFutureRecurrence").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
            task.get("pushCount").and_then(|v| v.as_i64()),
            tags_json,
            contexts_json,
            checklist_json,
            task.get("description").and_then(|v| v.as_str()),
            task.get("textDirection").and_then(|v| v.as_str()),
            attachments_json,
            task.get("location").and_then(|v| v.as_str()),
            task.get("projectId").and_then(|v| v.as_str()),
            task.get("sectionId").and_then(|v| v.as_str()),
            view_section_ids_json,
            task.get("areaId").and_then(|v| v.as_str()),
            task.get("order")
                .and_then(|v| v.as_f64())
                .filter(|order| order.is_finite())
                .or_else(|| {
                    task.get("orderNum")
                        .and_then(|v| v.as_f64())
                        .filter(|order| order.is_finite())
                }),
            task.get("boardOrder").and_then(|v| v.as_f64()),
            task.get("focusOrder").and_then(|v| v.as_f64()),
            task.get("isFocusedToday").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
            task.get("timeEstimate").and_then(|v| v.as_str()),
            task.get("suppressMindwtrReminders").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
            task.get("repeatReminderMinutes").and_then(|v| v.as_i64()),
            task.get("reviewAt").and_then(|v| v.as_str()),
            task.get("completedAt").and_then(|v| v.as_str()),
            task
                .get("statusBeforeProjectArchive")
                .and_then(|v| v.as_str()),
            task
                .get("completedAtBeforeProjectArchive")
                .and_then(|v| v.as_str()),
            task
                .get("isFocusedTodayBeforeProjectArchive")
                .and_then(|v| v.as_bool())
                .map(|v| v as i32),
            task.get("projectArchivedAt").and_then(|v| v.as_str()),
            normalized_rev,
            normalized_rev_by.as_deref(),
            task.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
            task.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
            task.get("deletedAt").and_then(|v| v.as_str()),
            task.get("purgedAt").and_then(|v| v.as_str()),
            task.get("timeSpentMinutes").and_then(|v| v.as_i64()),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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
    if let Ok(val) = row.get::<_, Option<String>>("energyLevel") {
        if let Some(v) = val {
            map.insert("energyLevel".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("assignedTo") {
        if let Some(v) = val {
            map.insert("assignedTo".to_string(), Value::String(v));
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
    let relative_start_offset_raw: Option<String> = row.get("relativeStartOffset")?;
    let relative_start_offset_val = parse_json_value(relative_start_offset_raw);
    if !relative_start_offset_val.is_null() {
        map.insert("relativeStartOffset".to_string(), relative_start_offset_val);
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
    // Canonical wire form is `true` or ABSENT, never `false` (the merge rule in
    // packages/core/src/sync-normalization.ts). Reading a stored 0 (or NULL) back
    // as absent keeps this reader in step with the JS codec's fromPresentBool and
    // absorbs every legacy row without a migration.
    if let Ok(val) = row.get::<_, i64>("showFutureRecurrence") {
        if val != 0 {
            map.insert("showFutureRecurrence".to_string(), Value::Bool(true));
        }
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
    if let Ok(val) = row.get::<_, Option<String>>("textDirection") {
        if let Some(v) = val {
            map.insert("textDirection".to_string(), Value::String(v));
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
    let view_section_ids_raw: Option<String> = row.get("viewSectionIds")?;
    let view_section_ids_val = parse_json_value(view_section_ids_raw);
    if !view_section_ids_val.is_null() {
        map.insert("viewSectionIds".to_string(), view_section_ids_val);
    }
    if let Ok(val) = row.get::<_, Option<String>>("areaId") {
        if let Some(v) = val {
            map.insert("areaId".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<f64>>("orderNum") {
        if let Some(num) = val.and_then(json_number_from_f64) {
            map.insert("order".to_string(), num.clone());
            map.insert("orderNum".to_string(), num);
        }
    }
    if let Ok(val) = row.get::<_, Option<f64>>("boardOrder") {
        if let Some(num) = val.and_then(json_number_from_f64) {
            map.insert("boardOrder".to_string(), num);
        }
    }
    if let Ok(val) = row.get::<_, Option<f64>>("focusOrder") {
        if let Some(num) = val.and_then(json_number_from_f64) {
            map.insert("focusOrder".to_string(), num);
        }
    }
    if let Ok(val) = row.get::<_, i64>("isFocusedToday") {
        map.insert("isFocusedToday".to_string(), Value::Bool(val != 0));
    }
    if let Ok(val) = row.get::<_, Option<String>>("timeEstimate") {
        if let Some(v) = val {
            map.insert("timeEstimate".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, i64>("suppressMindwtrReminders") {
        map.insert(
            "suppressMindwtrReminders".to_string(),
            Value::Bool(val != 0),
        );
    }
    if let Ok(val) = row.get::<_, Option<i64>>("repeatReminderMinutes") {
        if let Some(v) = val {
            map.insert("repeatReminderMinutes".to_string(), Value::Number(v.into()));
        }
    }
    if let Ok(val) = row.get::<_, Option<i64>>("timeSpentMinutes") {
        if let Some(v) = val {
            map.insert("timeSpentMinutes".to_string(), Value::Number(v.into()));
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
    if let Ok(val) = row.get::<_, Option<String>>("statusBeforeProjectArchive") {
        if let Some(v) = val {
            map.insert("statusBeforeProjectArchive".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("completedAtBeforeProjectArchive") {
        if let Some(v) = val {
            map.insert(
                "completedAtBeforeProjectArchive".to_string(),
                Value::String(v),
            );
        }
    }
    if let Ok(val) = row.get::<_, Option<i64>>("isFocusedTodayBeforeProjectArchive") {
        if let Some(v) = val {
            map.insert(
                "isFocusedTodayBeforeProjectArchive".to_string(),
                Value::Bool(v != 0),
            );
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("projectArchivedAt") {
        if let Some(v) = val {
            map.insert("projectArchivedAt".to_string(), Value::String(v));
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
    if let Ok(val) = row.get::<_, Option<f64>>("orderNum") {
        if let Some(num) = val.and_then(json_number_from_f64) {
            map.insert("order".to_string(), num);
        }
    }
    let tag_ids_raw: Option<String> = row.get("tagIds")?;
    map.insert("tagIds".to_string(), parse_json_array(tag_ids_raw));
    if let Ok(val) = row.get::<_, i64>("isSequential") {
        map.insert("isSequential".to_string(), Value::Bool(val != 0));
    }
    if let Ok(val) = row.get::<_, Option<String>>("sequentialScope") {
        if let Some(v) = val {
            map.insert("sequentialScope".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("taskSortBy") {
        if let Some(v) = normalize_project_task_sort_by(val.as_deref()) {
            map.insert("taskSortBy".to_string(), Value::String(v.to_string()));
        }
    }
    if let Ok(val) = row.get::<_, i64>("isFocused") {
        map.insert("isFocused".to_string(), Value::Bool(val != 0));
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
    if let Ok(val) = row.get::<_, Option<String>>("dueDate") {
        if let Some(v) = val {
            map.insert("dueDate".to_string(), Value::String(v));
        }
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
    if let Ok(val) = row.get::<_, Option<String>>("purgedAt") {
        if let Some(v) = val {
            map.insert("purgedAt".to_string(), Value::String(v));
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
    if let Ok(val) = row.get::<_, Option<f64>>("orderNum") {
        if let Some(num) = val.and_then(json_number_from_f64) {
            map.insert("order".to_string(), num);
        }
    }
    if let Ok(val) = row.get::<_, i64>("isCollapsed") {
        map.insert("isCollapsed".to_string(), Value::Bool(val != 0));
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
    if let Ok(val) = row.get::<_, Option<String>>("deletedAtBeforeProjectArchive") {
        if let Some(v) = val {
            map.insert(
                "deletedAtBeforeProjectArchive".to_string(),
                Value::String(v),
            );
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("projectArchivedAt") {
        if let Some(v) = val {
            map.insert("projectArchivedAt".to_string(), Value::String(v));
        }
    }
    Ok(Value::Object(map))
}

fn row_to_person_value(row: &rusqlite::Row<'_>) -> Result<Value, rusqlite::Error> {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), Value::String(row.get::<_, String>("id")?));
    map.insert(
        "name".to_string(),
        Value::String(row.get::<_, String>("name")?),
    );
    if let Ok(val) = row.get::<_, Option<String>>("note") {
        if let Some(v) = val {
            map.insert("note".to_string(), Value::String(v));
        }
    }
    if let Ok(val) = row.get::<_, Option<String>>("referenceLink") {
        if let Some(v) = val {
            map.insert("referenceLink".to_string(), Value::String(v));
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

fn optional_id(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string)
}

fn collect_ids(data: &Value, key: &str) -> std::collections::HashSet<String> {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn collect_live_ids(data: &Value, key: &str) -> std::collections::HashSet<String> {
    data.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| !entity_is_deleted(item))
                .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn reference_repair_identity(data: &Value) -> String {
    data.get("settings")
        .and_then(|settings| settings.get("deviceId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|device_id| !device_id.is_empty())
        .unwrap_or("sync-repair")
        .to_string()
}

fn reference_repair_timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn stamp_reference_repair(entity: &mut Value, now: &str, rev_by: &str, tombstone: bool) {
    let next_revision = entity_revision(entity).saturating_add(1).min(2_147_483_647);
    let Some(entity) = entity.as_object_mut() else {
        return;
    };
    if tombstone {
        entity.insert("deletedAt".to_string(), Value::String(now.to_string()));
    }
    entity.insert("updatedAt".to_string(), Value::String(now.to_string()));
    entity.insert("rev".to_string(), Value::Number(next_revision.into()));
    entity.insert("revBy".to_string(), Value::String(rev_by.to_string()));
}

/// Repairs project/task container references that don't resolve to a live row
/// and tombstones orphaned sections with fresh revision metadata. A section
/// whose parent row is physically absent is routed to the transactional
/// sidecar table because the primary sections table has a NOT NULL project FK;
/// canonical reads merge that tombstone back into the one sections array.
/// Mutates `data` in place and returns each issue found in the same
/// `(kind, id, missingId)` shape as core's own diagnostic instrumentation
/// (`SqliteReferenceIssue` in sqlite-adapter.ts), for the caller to log.
fn sanitize_dangling_container_references(data: &mut Value) -> Vec<(&'static str, String, String)> {
    let area_ids = collect_ids(data, "areas");
    let project_ids = collect_ids(data, "projects");
    let live_area_ids = collect_live_ids(data, "areas");
    let live_project_ids = collect_live_ids(data, "projects");
    let repair_rev_by = reference_repair_identity(data);
    let repair_now = reference_repair_timestamp();
    let mut issues: Vec<(&'static str, String, String)> = Vec::new();

    if let Some(projects) = data.get_mut("projects").and_then(|v| v.as_array_mut()) {
        for project in projects {
            let project_is_deleted = entity_is_deleted(project);
            let Some(area_id) = optional_id(project.get("areaId")) else {
                continue;
            };
            let valid_area_ids = if project_is_deleted {
                &area_ids
            } else {
                &live_area_ids
            };
            if valid_area_ids.contains(&area_id) {
                continue;
            }
            let id = project
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            issues.push(("project.areaId", id, area_id));
            if let Some(obj) = project.as_object_mut() {
                obj.remove("areaId");
            }
            if !project_is_deleted {
                stamp_reference_repair(project, &repair_now, &repair_rev_by, false);
            }
        }
    }

    if let Some(sections) = data.get_mut("sections").and_then(|v| v.as_array_mut()) {
        for section in sections {
            let project_id = optional_id(section.get("projectId")).unwrap_or_default();
            let section_is_deleted = entity_is_deleted(section);
            let valid_project_ids = if section_is_deleted {
                &project_ids
            } else {
                &live_project_ids
            };
            if valid_project_ids.contains(&project_id) {
                continue;
            }
            let id = section
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if !section_is_deleted {
                issues.push(("section.projectId", id, project_id.clone()));
                stamp_reference_repair(section, &repair_now, &repair_rev_by, true);
            }
        }
    }
    let section_projects = data
        .get("sections")
        .and_then(Value::as_array)
        .map(|sections| {
            sections
                .iter()
                .filter_map(|section| {
                    let id = optional_id(section.get("id"))?;
                    let project_id = optional_id(section.get("projectId"))?;
                    project_ids
                        .contains(&project_id)
                        .then_some((id, project_id))
                })
                .collect::<std::collections::HashMap<_, _>>()
        })
        .unwrap_or_default();
    let live_section_projects = data
        .get("sections")
        .and_then(Value::as_array)
        .map(|sections| {
            sections
                .iter()
                .filter(|section| !entity_is_deleted(section))
                .filter_map(|section| {
                    let id = optional_id(section.get("id"))?;
                    let project_id = optional_id(section.get("projectId"))?;
                    live_project_ids
                        .contains(&project_id)
                        .then_some((id, project_id))
                })
                .collect::<std::collections::HashMap<_, _>>()
        })
        .unwrap_or_default();

    if let Some(tasks) = data.get_mut("tasks").and_then(|v| v.as_array_mut()) {
        for task in tasks {
            let task_is_deleted = entity_is_deleted(task);
            let id = task
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let mut changed = false;
            if let Some(project_id) = optional_id(task.get("projectId")) {
                let valid_project_ids = if task_is_deleted {
                    &project_ids
                } else {
                    &live_project_ids
                };
                if !valid_project_ids.contains(&project_id) {
                    issues.push(("task.projectId", id.clone(), project_id));
                    if let Some(task) = task.as_object_mut() {
                        task.remove("projectId");
                        if let Some(section_id) = optional_id(task.get("sectionId")) {
                            issues.push(("task.sectionId", id.clone(), section_id));
                        }
                        task.remove("sectionId");
                    }
                    changed = true;
                }
            }
            if let Some(section_id) = optional_id(task.get("sectionId")) {
                let task_project_id = optional_id(task.get("projectId"));
                let section_project_id = if task_is_deleted {
                    section_projects.get(&section_id)
                } else {
                    live_section_projects.get(&section_id)
                };
                if section_project_id.is_none()
                    || task_project_id
                        .as_ref()
                        .is_some_and(|project_id| section_project_id != Some(project_id))
                {
                    issues.push(("task.sectionId", id.clone(), section_id));
                    if let Some(task) = task.as_object_mut() {
                        task.remove("sectionId");
                    }
                    changed = true;
                }
            }
            if let Some(area_id) = optional_id(task.get("areaId")) {
                let valid_area_ids = if task_is_deleted {
                    &area_ids
                } else {
                    &live_area_ids
                };
                if !valid_area_ids.contains(&area_id) {
                    issues.push(("task.areaId", id.clone(), area_id));
                    if let Some(task) = task.as_object_mut() {
                        task.remove("areaId");
                    }
                    changed = true;
                }
            }
            if changed && !task_is_deleted {
                stamp_reference_repair(task, &repair_now, &repair_rev_by, false);
            }
        }
    }

    issues
}

fn take_orphan_section_tombstones(data: &mut Value) -> Vec<Value> {
    let project_ids = collect_ids(data, "projects");
    let Some(sections) = data.get_mut("sections").and_then(Value::as_array_mut) else {
        return Vec::new();
    };
    let mut regular = Vec::with_capacity(sections.len());
    let mut orphaned = Vec::new();
    for mut section in std::mem::take(sections) {
        // Older or externally edited JSON may contain the former private
        // marker. It is untrusted input: scrub it and derive sidecar routing
        // solely from the persisted entity relationship.
        if let Some(section) = section.as_object_mut() {
            section.remove("_mindwtrOrphanSectionTombstone");
        }
        let parent_is_physically_absent = optional_id(section.get("projectId"))
            .map_or(true, |project_id| !project_ids.contains(&project_id));
        if entity_is_deleted(&section) && parent_is_physically_absent {
            orphaned.push(section);
        } else {
            regular.push(section);
        }
    }
    *sections = regular;
    orphaned
}

fn entity_revision(value: &Value) -> i64 {
    const MAX_CORE_REVISION: i64 = 2_147_483_647;
    value
        .get("rev")
        .and_then(|revision| {
            revision
                .as_i64()
                .map(|revision| revision.clamp(0, MAX_CORE_REVISION))
                .or_else(|| {
                    revision
                        .as_u64()
                        .map(|revision| revision.min(MAX_CORE_REVISION as u64) as i64)
                })
        })
        .unwrap_or(0)
}

fn normalized_revision_for_storage(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if value.as_i64().is_some_and(|revision| revision < 0) {
        return None;
    }
    let revision = value.as_i64().or_else(|| {
        value
            .as_u64()
            .map(|revision| revision.min(i64::MAX as u64) as i64)
    })?;
    Some(revision.min(2_147_483_647))
}

fn normalized_rev_by(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|rev_by| !rev_by.is_empty())
        .map(str::to_string)
}

const DELETE_VS_LIVE_AMBIGUOUS_WINDOW_NANOS: i128 = 30_000_000_000;
const CLOCK_SKEW_THRESHOLD_NANOS: i128 = 5 * 60 * 1_000_000_000;
const SYNC_BACKUP_RESTORE_REV_BY: &str = "backup-restore";

fn entity_has_revision(value: &Value) -> bool {
    entity_revision(value) > 0
        || value
            .get("revBy")
            .and_then(Value::as_str)
            .is_some_and(|rev_by| !rev_by.trim().is_empty())
}

fn entity_is_deleted(value: &Value) -> bool {
    ["deletedAt", "purgedAt"].iter().any(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|timestamp| !timestamp.is_empty())
    })
}

fn parse_entity_timestamp(value: Option<&Value>) -> Option<i128> {
    value
        .and_then(Value::as_str)
        .and_then(|timestamp| {
            OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339)
                .ok()
                .or_else(|| {
                    let bytes = timestamp.as_bytes();
                    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
                        return None;
                    }
                    let year = timestamp[0..4].parse::<i32>().ok()?;
                    let month = timestamp[5..7].parse::<u8>().ok()?;
                    let day = timestamp[8..10].parse::<u8>().ok()?;
                    time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day)
                        .ok()
                        .map(|date| date.midnight().assume_utc())
                })
        })
        .map(OffsetDateTime::unix_timestamp_nanos)
}

#[derive(Clone, Copy)]
struct EntityTimestampInfo {
    raw: Option<i128>,
    safe: Option<i128>,
    was_clamped: bool,
}

fn entity_timestamp_info(value: Option<&Value>, merge_now: i128) -> EntityTimestampInfo {
    let raw = parse_entity_timestamp(value);
    let future_limit = merge_now.saturating_add(CLOCK_SKEW_THRESHOLD_NANOS);
    let was_clamped = raw.is_some_and(|timestamp| timestamp > future_limit);
    EntityTimestampInfo {
        raw,
        safe: raw.map(|timestamp| if was_clamped { merge_now } else { timestamp }),
        was_clamped,
    }
}

fn entity_timestamp_order(
    current: EntityTimestampInfo,
    incoming: EntityTimestampInfo,
) -> std::cmp::Ordering {
    incoming.safe.cmp(&current.safe).then_with(|| {
        if current.was_clamped && incoming.was_clamped {
            incoming.raw.cmp(&current.raw)
        } else {
            std::cmp::Ordering::Equal
        }
    })
}

fn entity_operation_time(value: &Value, merge_now: i128) -> Option<i128> {
    ["updatedAt", "deletedAt", "purgedAt"]
        .iter()
        .filter_map(|key| entity_timestamp_info(value.get(*key), merge_now).safe)
        .max()
}

fn incoming_delete_vs_live_wins_at(
    current: &Value,
    incoming: &Value,
    merge_now: i128,
) -> Option<bool> {
    let current_deleted = entity_is_deleted(current);
    let incoming_deleted = entity_is_deleted(incoming);
    if current_deleted == incoming_deleted {
        return None;
    }

    let current_operation_time = entity_operation_time(current, merge_now);
    let incoming_operation_time = entity_operation_time(incoming, merge_now);
    let current_is_backup_restore = !current_deleted
        && current
            .get("revBy")
            .and_then(Value::as_str)
            .is_some_and(|rev_by| rev_by.trim() == SYNC_BACKUP_RESTORE_REV_BY);
    let incoming_is_backup_restore = !incoming_deleted
        && incoming
            .get("revBy")
            .and_then(Value::as_str)
            .is_some_and(|rev_by| rev_by.trim() == SYNC_BACKUP_RESTORE_REV_BY);
    let backup_restore_winner = if current_is_backup_restore {
        Some((false, current_operation_time, incoming_operation_time))
    } else if incoming_is_backup_restore {
        Some((true, incoming_operation_time, current_operation_time))
    } else {
        None
    };
    if let Some((incoming_is_restore, restore_time, tombstone_time)) = backup_restore_winner {
        let restore_is_not_older = match (restore_time, tombstone_time) {
            (Some(restore), Some(tombstone)) => restore >= tombstone,
            (Some(_), None) | (None, None) => true,
            (None, Some(_)) => false,
        };
        if restore_is_not_older {
            return Some(incoming_is_restore);
        }
    }
    let within_ambiguity_window = match (current_operation_time, incoming_operation_time) {
        (Some(current), Some(incoming)) => {
            incoming.abs_diff(current) <= DELETE_VS_LIVE_AMBIGUOUS_WINDOW_NANOS as u128
        }
        (None, None) => true,
        _ => false,
    };

    if within_ambiguity_window {
        let has_revision = entity_has_revision(current) || entity_has_revision(incoming);
        let revision_order = entity_revision(incoming).cmp(&entity_revision(current));
        if has_revision && !revision_order.is_eq() {
            return Some(revision_order.is_gt());
        }
        // ADR 0007: revisioned records preserve the live side inside the
        // ambiguity window. Legacy records without revisions retain the old
        // tombstone preference so replicas still converge deterministically.
        return Some(if has_revision {
            !incoming_deleted
        } else {
            incoming_deleted
        });
    }

    match (current_operation_time, incoming_operation_time) {
        (Some(current), Some(incoming)) if incoming != current => Some(incoming > current),
        (None, Some(_)) => Some(true),
        (Some(_), None) => Some(false),
        // Equal/unparseable non-ambiguous operation times finish with the
        // core merge contract's deterministic delete preference.
        _ => Some(incoming_deleted),
    }
}

fn entity_signature_value(value: &Value, include_ignored_keys: bool) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Array(values) => {
            let comparable = values
                .iter()
                .filter_map(|value| entity_signature_value(value, include_ignored_keys))
                .collect::<Vec<_>>();
            (!comparable.is_empty()).then_some(Value::Array(comparable))
        }
        Value::Object(values) => {
            let kind_is_file = values.get("kind").and_then(Value::as_str) == Some("file");
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut comparable = Map::new();
            for key in keys {
                if matches!(
                    key.as_str(),
                    "statusBeforeProjectArchive"
                        | "completedAtBeforeProjectArchive"
                        | "isFocusedTodayBeforeProjectArchive"
                        | "deletedAtBeforeProjectArchive"
                        | "projectArchivedAt"
                ) {
                    continue;
                }
                if !include_ignored_keys
                    && matches!(
                        key.as_str(),
                        "rev"
                            | "revBy"
                            | "updatedAt"
                            | "createdAt"
                            | "localStatus"
                            | "purgedAt"
                            | "order"
                            | "orderNum"
                            | "boardOrder"
                            | "focusOrder"
                    )
                {
                    continue;
                }
                if !include_ignored_keys && key == "uri" && kind_is_file {
                    continue;
                }
                if let Some(value) = entity_signature_value(&values[key], include_ignored_keys) {
                    comparable.insert(key.clone(), value);
                }
            }
            (!comparable.is_empty()).then_some(Value::Object(comparable))
        }
        Value::String(value) => {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| Value::String(trimmed.to_string()))
        }
        value => Some(value.clone()),
    }
}

fn entity_tie_break_json(value: &Value, include_ignored_keys: bool) -> String {
    serde_json::to_string(&entity_signature_value(value, include_ignored_keys)).unwrap_or_default()
}

fn normalize_entity_signature_pair(current: &Value, incoming: &Value) -> (Value, Value) {
    let mut current = current.as_object().cloned().unwrap_or_default();
    let mut incoming = incoming.as_object().cloned().unwrap_or_default();
    for entity in [&mut current, &mut incoming] {
        match normalized_revision_for_storage(entity.get("rev")) {
            Some(revision) => {
                entity.insert("rev".to_string(), Value::Number(revision.into()));
            }
            None => {
                entity.remove("rev");
            }
        }
        match normalized_rev_by(entity.get("revBy")) {
            Some(rev_by) => {
                entity.insert("revBy".to_string(), Value::String(rev_by));
            }
            None => {
                entity.remove("revBy");
            }
        }
    }
    for key in [
        "showFutureRecurrence",
        "isFocusedToday",
        "suppressMindwtrReminders",
        "isSequential",
        "isFocused",
        "isCollapsed",
    ] {
        if current.contains_key(key) || incoming.contains_key(key) {
            current.entry(key.to_string()).or_insert(Value::Bool(false));
            incoming
                .entry(key.to_string())
                .or_insert(Value::Bool(false));
        }
    }
    (Value::Object(current), Value::Object(incoming))
}

fn entity_tie_break_order(current: &Value, incoming: &Value) -> std::cmp::Ordering {
    let (current, incoming) = normalize_entity_signature_pair(current, incoming);
    entity_tie_break_json(&incoming, false)
        .cmp(&entity_tie_break_json(&current, false))
        .then_with(|| {
            entity_tie_break_json(&incoming, true).cmp(&entity_tie_break_json(&current, true))
        })
}

#[cfg(test)]
fn incoming_entity_wins(current: &Value, incoming: &Value) -> bool {
    incoming_entity_wins_at(
        current,
        incoming,
        OffsetDateTime::now_utc().unix_timestamp_nanos(),
    )
}

fn incoming_entity_wins_at(current: &Value, incoming: &Value, merge_now: i128) -> bool {
    if let Some(incoming_wins) = incoming_delete_vs_live_wins_at(current, incoming, merge_now) {
        return incoming_wins;
    }
    let has_revision = entity_has_revision(current) || entity_has_revision(incoming);
    let current_rev_by = current
        .get("revBy")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let incoming_rev_by = incoming
        .get("revBy")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let current_timestamp = entity_timestamp_info(current.get("updatedAt"), merge_now);
    let incoming_timestamp = entity_timestamp_info(incoming.get("updatedAt"), merge_now);
    let raw_timestamp_order = entity_timestamp_order(current_timestamp, incoming_timestamp);
    let timestamp_order = match (current_timestamp.safe, incoming_timestamp.safe) {
        // Core deliberately ignores small timestamp differences on legacy
        // rows: without a revision they are plausible clock skew, not a safe
        // causal order. Content signatures make every replica converge.
        (Some(current), Some(incoming))
            if !has_revision
                && !current_timestamp.was_clamped
                && !incoming_timestamp.was_clamped
                && incoming.abs_diff(current) <= CLOCK_SKEW_THRESHOLD_NANOS as u128 =>
        {
            std::cmp::Ordering::Equal
        }
        _ => raw_timestamp_order,
    };
    let order = entity_revision(incoming)
        .cmp(&entity_revision(current))
        .then(timestamp_order)
        // Match core: revBy resolves an otherwise equal revision/time only
        // when both clients supplied it. A legacy row with no revBy falls
        // through to the deterministic content signature instead.
        .then_with(
            || match (current_rev_by.is_empty(), incoming_rev_by.is_empty()) {
                (false, false) => incoming_rev_by.cmp(current_rev_by),
                _ => std::cmp::Ordering::Equal,
            },
        )
        .then_with(|| entity_tie_break_order(current, incoming));
    // Core's deterministic winner selects the incoming value on an exact
    // comparable + full-signature tie. This also permits otherwise ignored
    // archive-bookkeeping differences to flow through without oscillation.
    !order.is_lt()
}

fn entities_by_id(entities: &[Value]) -> HashMap<&str, &Value> {
    entities
        .iter()
        .filter_map(|entity| {
            entity
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id, entity))
        })
        .collect()
}

fn merge_entity_snapshots(
    current: &[Value],
    incoming: &[Value],
    changed_baseline: &[Value],
    observed_ids: &HashSet<&str>,
    merge_now: i128,
) -> Vec<Value> {
    let incoming_by_id = entities_by_id(incoming);
    let baseline_by_id = entities_by_id(changed_baseline);
    let current_ids: HashMap<&str, ()> = current
        .iter()
        .filter_map(|entity| entity.get("id").and_then(Value::as_str).map(|id| (id, ())))
        .collect();
    let mut merged = Vec::with_capacity(current.len().max(incoming.len()));

    for canonical in current {
        let Some(id) = canonical.get("id").and_then(Value::as_str) else {
            merged.push(canonical.clone());
            continue;
        };
        let baseline_matches = baseline_by_id
            .get(id)
            .is_some_and(|baseline| *baseline == canonical);

        match incoming_by_id.get(id) {
            // A caller may replace a row exactly (including pruning nested
            // attachment tombstones without bumping the task rev) only when
            // the row it originally observed is still canonical. The CAS
            // never authorizes rolling the entity revision backward.
            Some(target) if baseline_matches => {
                if entity_revision(target) >= entity_revision(canonical) {
                    merged.push((*target).clone());
                } else {
                    merged.push(canonical.clone());
                }
            }
            Some(target) if incoming_entity_wins_at(canonical, target, merge_now) => {
                merged.push((*target).clone())
            }
            Some(_) => merged.push(canonical.clone()),
            // Omission is a physical removal only when it is a CAS against
            // the exact row the caller observed. Unseen/concurrently changed
            // rows remain intact.
            None if baseline_matches => {}
            None => merged.push(canonical.clone()),
        }
    }

    for entity in incoming {
        let Some(id) = entity.get("id").and_then(Value::as_str) else {
            continue;
        };
        // A row absent from the canonical snapshot may have been removed by
        // an exact restore after this caller observed it. Sparse changed-row
        // baselines alone cannot distinguish that stale row from a genuine
        // local create, so the caller also sends the IDs it observed. Existing
        // changed-baseline rows count as observed for older callers.
        if !current_ids.contains_key(id)
            && !observed_ids.contains(id)
            && !baseline_by_id.contains_key(id)
        {
            merged.push(entity.clone());
        }
    }
    merged
}

fn merge_data_snapshots(
    current: &Value,
    incoming: &Value,
    baseline_entities: Option<&Value>,
) -> Value {
    let merge_now = OffsetDateTime::now_utc().unix_timestamp_nanos();
    merge_data_snapshots_at(current, incoming, baseline_entities, merge_now)
}

fn merge_data_snapshots_at(
    current: &Value,
    incoming: &Value,
    baseline_entities: Option<&Value>,
    merge_now: i128,
) -> Value {
    let mut merged = incoming.as_object().cloned().unwrap_or_default();
    for key in ENTITY_TABLES {
        let current_entities = current
            .get(key)
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let incoming_entities = incoming
            .get(key)
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let changed_baseline = baseline_entities
            .and_then(|baseline| baseline.get(key))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let observed_ids = baseline_entities
            .and_then(|baseline| baseline.get("observedEntityIds"))
            .and_then(|observed| observed.get(key))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<HashSet<_>>();
        merged.insert(
            key.to_string(),
            Value::Array(merge_entity_snapshots(
                current_entities,
                incoming_entities,
                changed_baseline,
                &observed_ids,
                merge_now,
            )),
        );
    }
    // Settings are one explicit, unsynced document rather than revisioned
    // entities. Legacy/migration callers without a baseline retain replacement
    // behavior. Normal saves must compare-and-swap the exact settings document
    // they observed; an absent/stale baseline cannot overwrite a concurrent
    // settings update.
    let incoming_settings_are_accepted = incoming.get("settings").is_some_and(Value::is_object)
        && match baseline_entities {
            None => true,
            Some(baseline) => baseline
                .get("settings")
                .zip(current.get("settings"))
                .is_some_and(|(observed, canonical)| observed == canonical),
        };
    if !incoming_settings_are_accepted {
        merged.insert(
            "settings".to_string(),
            current
                .get("settings")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new())),
        );
    }
    Value::Object(merged)
}

fn normalize_revision_metadata_in_data(data: &mut Value) {
    for collection in ENTITY_TABLES {
        let Some(entities) = data.get_mut(collection).and_then(Value::as_array_mut) else {
            continue;
        };
        for entity in entities {
            let Some(entity) = entity.as_object_mut() else {
                continue;
            };
            match normalized_revision_for_storage(entity.get("rev")) {
                Some(revision) => {
                    entity.insert("rev".to_string(), Value::Number(revision.into()));
                }
                None => {
                    entity.remove("rev");
                }
            }
            match normalized_rev_by(entity.get("revBy")) {
                Some(rev_by) => {
                    entity.insert("revBy".to_string(), Value::String(rev_by));
                }
                None => {
                    entity.remove("revBy");
                }
            }
        }
    }
}

fn replace_data_in_transaction(conn: &Connection, mut data: Value) -> Result<Value, String> {
    ensure_orphan_section_tombstones_schema(conn)?;
    let issues = sanitize_dangling_container_references(&mut data);
    if !issues.is_empty() {
        log::warn!(
            "JSON->SQLite migration found {} dangling container reference(s), repaired/tombstoned: {}",
            issues.len(),
            issues
                .iter()
                .map(|(kind, id, missing_id)| format!("{kind}(id={id}, missingId={missing_id})"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    normalize_revision_metadata_in_data(&mut data);
    let orphan_section_tombstones = take_orphan_section_tombstones(&mut data);
    let data = &data;

    conn.execute("DELETE FROM tasks", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM areas", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sections", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM people", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM settings", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM orphan_section_tombstones", [])
        .map_err(|e| e.to_string())?;

    // Insert order is parent-before-child so each row's FK references
    // (tasks/sections -> projects, tasks/projects -> areas) already exist:
    // areas depend on nothing, projects depend on areas, sections depend on
    // projects, tasks depend on all three. `people`/`settings` have no FK
    // columns, so their position relative to the others is unconstrained.
    // This also matters beyond satisfying the constraint on this from-scratch
    // migration: `INSERT OR REPLACE` on a row whose id already exists
    // resolves the conflict by deleting the old row first, which fires the
    // same `ON DELETE CASCADE`/`SET NULL` actions - so on any write that
    // isn't a full wipe-and-reinsert (an incremental per-entity upsert
    // elsewhere), re-inserting a parent before its children are also
    // re-inserted can silently cascade-delete or null a child's own
    // reference. Parent-before-child order is load-bearing for data
    // integrity generally, not only for constraint satisfaction here.
    let areas = data
        .get("areas")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for area in areas {
        conn.execute(
            "INSERT OR REPLACE INTO areas (id, name, color, icon, orderNum, deletedAt, deletedAtBeforeProjectArchive, projectArchivedAt, rev, revBy, createdAt, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                area.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                area.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
                area.get("color").and_then(|v| v.as_str()),
                area.get("icon").and_then(|v| v.as_str()),
                area.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0),
                area.get("deletedAt").and_then(|v| v.as_str()),
                area.get("deletedAtBeforeProjectArchive")
                    .and_then(|v| v.as_str()),
                area.get("projectArchivedAt").and_then(|v| v.as_str()),
                area.get("rev").and_then(|v| v.as_i64()),
                area.get("revBy").and_then(|v| v.as_str()),
                area.get("createdAt").and_then(|v| v.as_str()),
                area.get("updatedAt").and_then(|v| v.as_str()),
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
        conn.execute(
            "INSERT OR REPLACE INTO projects (id, title, status, color, orderNum, tagIds, isSequential, sequentialScope, taskSortBy, isFocused, supportNotes, attachments, dueDate, reviewAt, areaId, areaTitle, rev, revBy, createdAt, updatedAt, deletedAt, purgedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            params![
                project.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("title").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("status").and_then(|v| v.as_str()).unwrap_or("active"),
                project.get("color").and_then(|v| v.as_str()).unwrap_or("#6B7280"),
                project.get("order").and_then(|v| v.as_f64()),
                tag_ids_json,
                project.get("isSequential").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                project.get("sequentialScope").and_then(|v| v.as_str()),
                normalize_project_task_sort_by(project.get("taskSortBy").and_then(|v| v.as_str())),
                project.get("isFocused").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                project.get("supportNotes").and_then(|v| v.as_str()),
                attachments_json,
                project.get("dueDate").and_then(|v| v.as_str()),
                project.get("reviewAt").and_then(|v| v.as_str()),
                project.get("areaId").and_then(|v| v.as_str()),
                project.get("areaTitle").and_then(|v| v.as_str()),
                project.get("rev").and_then(|v| v.as_i64()),
                project.get("revBy").and_then(|v| v.as_str()),
                project.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("deletedAt").and_then(|v| v.as_str()),
                project.get("purgedAt").and_then(|v| v.as_str()),
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
        conn.execute(
            "INSERT OR REPLACE INTO sections (id, projectId, title, description, orderNum, isCollapsed, rev, revBy, createdAt, updatedAt, deletedAt, deletedAtBeforeProjectArchive, projectArchivedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                section.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                section.get("projectId").and_then(|v| v.as_str()).unwrap_or_default(),
                section.get("title").and_then(|v| v.as_str()).unwrap_or_default(),
                section.get("description").and_then(|v| v.as_str()),
                section.get("order").and_then(|v| v.as_f64()),
                section.get("isCollapsed").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                section.get("rev").and_then(|v| v.as_i64()),
                section.get("revBy").and_then(|v| v.as_str()),
                section.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
                section.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
                section.get("deletedAt").and_then(|v| v.as_str()),
                section
                    .get("deletedAtBeforeProjectArchive")
                    .and_then(|v| v.as_str()),
                section.get("projectArchivedAt").and_then(|v| v.as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for section in orphan_section_tombstones {
        let id = section
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Orphan section tombstone id is required".to_string())?;
        let payload = serde_json::to_string(&section).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO orphan_section_tombstones (id, data) VALUES (?1, ?2)",
            params![id, payload],
        )
        .map_err(|e| e.to_string())?;
    }

    let tasks = data
        .get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for task in tasks {
        let tags_json = json_str_or_default(task.get("tags"), "[]");
        let contexts_json = json_str_or_default(task.get("contexts"), "[]");
        let relative_start_offset_json = json_str(task.get("relativeStartOffset"));
        let recurrence_json = json_str(task.get("recurrence"));
        let checklist_json = json_str(task.get("checklist"));
        let attachments_json = json_str(task.get("attachments"));
        let view_section_ids_json = json_str(task.get("viewSectionIds"));
        conn.execute(
            "INSERT OR REPLACE INTO tasks (id, title, status, priority, energyLevel, assignedTo, taskMode, startTime, relativeStartOffset, dueDate, recurrence, showFutureRecurrence, pushCount, tags, contexts, checklist, description, textDirection, attachments, location, projectId, sectionId, viewSectionIds, areaId, orderNum, boardOrder, focusOrder, isFocusedToday, timeEstimate, suppressMindwtrReminders, repeatReminderMinutes, reviewAt, completedAt, statusBeforeProjectArchive, completedAtBeforeProjectArchive, isFocusedTodayBeforeProjectArchive, projectArchivedAt, rev, revBy, createdAt, updatedAt, deletedAt, purgedAt, timeSpentMinutes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43, ?44)",
            params![
                task.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("title").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("status").and_then(|v| v.as_str()).unwrap_or("inbox"),
                task.get("priority").and_then(|v| v.as_str()),
                task.get("energyLevel").and_then(|v| v.as_str()),
                task.get("assignedTo").and_then(|v| v.as_str()),
                task.get("taskMode").and_then(|v| v.as_str()),
                task.get("startTime").and_then(|v| v.as_str()),
                relative_start_offset_json,
                task.get("dueDate").and_then(|v| v.as_str()),
                recurrence_json,
                task.get("showFutureRecurrence").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                task.get("pushCount").and_then(|v| v.as_i64()),
                tags_json,
                contexts_json,
                checklist_json,
                task.get("description").and_then(|v| v.as_str()),
                task.get("textDirection").and_then(|v| v.as_str()),
                attachments_json,
                task.get("location").and_then(|v| v.as_str()),
                task.get("projectId").and_then(|v| v.as_str()),
                task.get("sectionId").and_then(|v| v.as_str()),
                view_section_ids_json,
                task.get("areaId").and_then(|v| v.as_str()),
                task.get("order")
                    .and_then(|v| v.as_f64())
                    .filter(|order| order.is_finite())
                    .or_else(|| {
                        task.get("orderNum")
                            .and_then(|v| v.as_f64())
                            .filter(|order| order.is_finite())
                    }),
                task.get("boardOrder").and_then(|v| v.as_f64()),
                task.get("focusOrder").and_then(|v| v.as_f64()),
                task.get("isFocusedToday").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                task.get("timeEstimate").and_then(|v| v.as_str()),
                task.get("suppressMindwtrReminders").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                task.get("repeatReminderMinutes").and_then(|v| v.as_i64()),
                task.get("reviewAt").and_then(|v| v.as_str()),
                task.get("completedAt").and_then(|v| v.as_str()),
                task
                    .get("statusBeforeProjectArchive")
                    .and_then(|v| v.as_str()),
                task
                    .get("completedAtBeforeProjectArchive")
                    .and_then(|v| v.as_str()),
                task
                    .get("isFocusedTodayBeforeProjectArchive")
                    .and_then(|v| v.as_bool())
                    .map(|v| v as i32),
                task.get("projectArchivedAt").and_then(|v| v.as_str()),
                task.get("rev").and_then(|v| v.as_i64()),
                task.get("revBy").and_then(|v| v.as_str()),
                task.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("deletedAt").and_then(|v| v.as_str()),
                task.get("purgedAt").and_then(|v| v.as_str()),
                task.get("timeSpentMinutes").and_then(|v| v.as_i64()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let people = data
        .get("people")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for person in people {
        conn.execute(
            "INSERT OR REPLACE INTO people (id, name, note, referenceLink, rev, revBy, createdAt, updatedAt, deletedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                person.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                person.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
                person.get("note").and_then(|v| v.as_str()),
                person.get("referenceLink").and_then(|v| v.as_str()),
                person.get("rev").and_then(|v| v.as_i64()),
                person.get("revBy").and_then(|v| v.as_str()),
                person.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
                person.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
                person.get("deletedAt").and_then(|v| v.as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let settings_json = json_str(data.get("settings"));
    conn.execute(
        "INSERT INTO settings (id, data) VALUES (1, ?1)",
        params![settings_json.unwrap_or_else(|| "{}".to_string())],
    )
    .map_err(|e| e.to_string())?;

    read_sqlite_data(conn)
}

fn merge_json_to_sqlite(
    conn: &mut Connection,
    data: &Value,
    baseline_entities: Option<&Value>,
) -> Result<Value, String> {
    // Acquire the cross-process writer lock before reloading. A stale whole
    // snapshot can then merge with canonical rows without erasing an MCP,
    // CLI, or Local API write committed after the snapshot was captured.
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result: Result<Value, String> = (|| {
        let current = read_sqlite_data(conn)?;
        let merged = merge_data_snapshots(&current, data, baseline_entities);
        let canonical = replace_data_in_transaction(conn, merged)?;
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok(canonical)
    })();
    if result.is_err() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    result
}

fn migrate_json_to_sqlite(conn: &mut Connection, data: &Value) -> Result<(), String> {
    merge_json_to_sqlite(conn, data, None).map(|_| ())
}

fn replace_json_in_sqlite(conn: &mut Connection, data: &Value) -> Result<Value, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let canonical = replace_data_in_transaction(conn, data.clone())?;
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok(canonical)
    })();
    if result.is_err() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    result
}

#[cfg(test)]
fn mutate_data_in_transaction<T, F>(conn: &Connection, mutate: &mut F) -> Result<(T, Value), String>
where
    F: FnMut(&mut Value) -> Result<T, String>,
{
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let mut data = read_sqlite_data(&conn)?;
        let output = mutate(&mut data)?;
        let canonical = replace_data_in_transaction(&conn, data)?;
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok((output, canonical))
    })();
    if result.is_err() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    result
}

pub(crate) fn read_sqlite_data(conn: &Connection) -> Result<Value, String> {
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
    if sqlite_table_exists(conn, ORPHAN_SECTION_TOMBSTONES_TABLE)? {
        let mut orphan_stmt = conn
            .prepare("SELECT data FROM orphan_section_tombstones ORDER BY id")
            .map_err(|e| e.to_string())?;
        let orphan_rows = orphan_stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in orphan_rows {
            let payload = row.map_err(|e| e.to_string())?;
            let section: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
            sections.push(section);
        }
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
            if let Some(num) = json_number_from_f64(row.get::<_, f64>("orderNum")?) {
                map.insert("order".to_string(), num);
            }
            if let Ok(val) = row.get::<_, Option<String>>("deletedAt") {
                if let Some(v) = val {
                    map.insert("deletedAt".to_string(), Value::String(v));
                }
            }
            if let Ok(val) = row.get::<_, Option<String>>("deletedAtBeforeProjectArchive") {
                if let Some(v) = val {
                    map.insert(
                        "deletedAtBeforeProjectArchive".to_string(),
                        Value::String(v),
                    );
                }
            }
            if let Ok(val) = row.get::<_, Option<String>>("projectArchivedAt") {
                if let Some(v) = val {
                    map.insert("projectArchivedAt".to_string(), Value::String(v));
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

    let mut people_stmt = conn
        .prepare("SELECT * FROM people")
        .map_err(|e| e.to_string())?;
    let people_rows = people_stmt
        .query_map([], |row| row_to_person_value(row))
        .map_err(|e| e.to_string())?;
    let mut people: Vec<Value> = Vec::new();
    for row in people_rows {
        people.push(row.map_err(|e| e.to_string())?);
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
            "people": people,
            "settings": Value::Object(settings_val),
        })
        .as_object()
        .unwrap()
        .clone(),
    ))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarSyncEntryRecord {
    task_id: String,
    calendar_event_id: String,
    calendar_id: String,
    platform: String,
    last_synced_at: String,
}

fn row_to_calendar_sync_entry(
    row: &rusqlite::Row<'_>,
) -> Result<CalendarSyncEntryRecord, rusqlite::Error> {
    Ok(CalendarSyncEntryRecord {
        task_id: row.get("task_id")?,
        calendar_event_id: row.get("calendar_event_id")?,
        calendar_id: row.get("calendar_id")?,
        platform: row.get("platform")?,
        last_synced_at: row.get("last_synced_at")?,
    })
}

// Each call opens its own SQLite connection and runs one atomic statement
// (WAL) — no app-level read-modify-write, so no extra lock (B1).
#[tauri::command(async)]
pub(crate) fn get_calendar_sync_entry(
    app: tauri::AppHandle,
    task_id: String,
    platform: String,
) -> Result<Option<CalendarSyncEntryRecord>, String> {
    let conn = open_sqlite(&app)?;
    conn.query_row(
        "SELECT task_id, calendar_event_id, calendar_id, platform, last_synced_at FROM calendar_sync WHERE task_id = ?1 AND platform = ?2",
        params![task_id, platform],
        row_to_calendar_sync_entry,
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub(crate) fn upsert_calendar_sync_entry(
    app: tauri::AppHandle,
    entry: CalendarSyncEntryRecord,
) -> Result<bool, String> {
    let conn = open_sqlite(&app)?;
    conn.execute(
        "INSERT INTO calendar_sync (task_id, calendar_event_id, calendar_id, platform, last_synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(task_id, platform) DO UPDATE SET
           calendar_event_id = excluded.calendar_event_id,
           calendar_id = excluded.calendar_id,
           last_synced_at = excluded.last_synced_at",
        params![
            entry.task_id,
            entry.calendar_event_id,
            entry.calendar_id,
            entry.platform,
            entry.last_synced_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command(async)]
pub(crate) fn delete_calendar_sync_entry(
    app: tauri::AppHandle,
    task_id: String,
    platform: String,
) -> Result<bool, String> {
    let conn = open_sqlite(&app)?;
    conn.execute(
        "DELETE FROM calendar_sync WHERE task_id = ?1 AND platform = ?2",
        params![task_id, platform],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command(async)]
pub(crate) fn get_all_calendar_sync_entries(
    app: tauri::AppHandle,
    platform: String,
) -> Result<Vec<CalendarSyncEntryRecord>, String> {
    let conn = open_sqlite(&app)?;
    let mut stmt = conn
        .prepare("SELECT task_id, calendar_event_id, calendar_id, platform, last_synced_at FROM calendar_sync WHERE platform = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![platform], row_to_calendar_sync_entry)
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| e.to_string())?);
    }
    Ok(entries)
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
    cleanup_stale_data_json_backup(&data_path)?;
    if !data_path.exists() {
        let mut legacy_sources = Vec::new();
        if let Some(custom_path) = legacy_config.data_file_path.as_ref() {
            legacy_sources.push(PathBuf::from(custom_path));
        }
        legacy_sources.push(config_dir.join(DATA_FILE_NAME));
        legacy_sources.push(get_legacy_data_json_path(app));
        for source in legacy_sources {
            if !source.exists() {
                continue;
            }
            match read_json_with_retries(&source, 2) {
                Ok(value) => {
                    write_initial_data_json_file(&data_path, &value)?;
                    return Ok(());
                }
                Err(error) => {
                    log::warn!(
                        "Skipping invalid legacy data file {} during bootstrap: {error}",
                        source.display()
                    );
                }
            }
        }

        let initial_data = serde_json::json!({
            "tasks": [],
            "projects": [],
            "settings": {}
        });
        write_initial_data_json_file(&data_path, &initial_data)?;
    }

    Ok(())
}

pub(crate) fn ensure_data_file(app: &tauri::AppHandle) -> Result<(), String> {
    bootstrap_storage_layout(app)
}

#[tauri::command]
pub(crate) async fn get_data(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || load_data_snapshot(&app))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn load_data_snapshot(app: &tauri::AppHandle) -> Result<Value, String> {
    ensure_data_file(app)?;
    let data_path = get_data_path(app);
    let backup_path = data_json_backup_path(&data_path);
    let mut conn = open_sqlite(app)?;

    if !sqlite_has_any_data(&conn)? && data_path.exists() {
        if let Ok(value) = read_json_with_retries(&data_path, 2) {
            let _ = fs::copy(&data_path, &backup_path);
            // A first-load migration failure must not brick the app: fall
            // through to the JSON already in hand (sanitize_dangling_container_references
            // above should prevent an FK failure here in the first place, but
            // this is the backstop for anything else that goes wrong) instead
            // of hard-failing the whole load.
            if let Err(error) = migrate_json_to_sqlite(&mut conn, &value) {
                log::warn!(
                    "First-load JSON->SQLite migration failed, using JSON directly: {error}"
                );
                return Ok(value);
            }
            rebuild_fts_atomically(&mut conn)?;
        }
    }

    match read_sqlite_snapshot(&conn) {
        // Once SQLite has any canonical data, even an empty settings object is
        // authoritative: it can be an intentional reset. data.json is only a
        // first-load/failure fallback and must not resurrect stale settings if
        // its best-effort refresh failed after that reset committed.
        Ok(value) => Ok(value),
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
}

#[tauri::command]
pub(crate) async fn read_data_json(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_path = get_data_path(&app);
        let _publication_guard = lock_data_json_publication()?;
        cleanup_stale_data_json_backup_unlocked(&data_path)?;
        read_json_with_retries(&data_path, 2).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn save_data(
    app: tauri::AppHandle,
    data: Value,
    baseline_entities: Option<Value>,
    mode: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || match mode.as_deref() {
        None | Some("merge") => {
            persist_data_snapshot_with_retries(&app, &data, baseline_entities.as_ref())
        }
        Some("exact") => persist_data_snapshot_exact_with_retries(&app, &data),
        Some(unsupported) => Err(format!("Unsupported save_data mode: {unsupported}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) const TASK_MUTATION_FOCUSED_COUNT_KEY: &str = "_localApiFocusedTaskCount";
pub(crate) const TASK_MUTATION_PROJECT_NEXT_ORDERS_KEY: &str = "_localApiProjectNextOrders";

#[derive(Debug, Clone, Default)]
pub(crate) struct TaskMutationReadScope {
    task_id: Option<String>,
    project_id: Option<String>,
    section_id: Option<String>,
    area_id: Option<String>,
    include_target_containers: bool,
    include_focus_context: bool,
}

impl TaskMutationReadScope {
    fn normalize_container_id(value: Option<&str>) -> Option<String> {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    pub(crate) fn existing(task_id: &str, include_target_containers: bool) -> Self {
        Self {
            task_id: Some(task_id.to_string()),
            include_target_containers,
            ..Self::default()
        }
    }

    pub(crate) fn create(
        project_id: Option<&str>,
        section_id: Option<&str>,
        area_id: Option<&str>,
        include_focus_context: bool,
    ) -> Self {
        Self {
            project_id: Self::normalize_container_id(project_id),
            section_id: Self::normalize_container_id(section_id),
            area_id: Self::normalize_container_id(area_id),
            include_focus_context,
            ..Self::default()
        }
    }

    pub(crate) fn patch(
        task_id: &str,
        project_id: Option<&str>,
        section_id: Option<&str>,
        area_id: Option<&str>,
    ) -> Self {
        Self {
            task_id: Some(task_id.to_string()),
            project_id: Self::normalize_container_id(project_id),
            section_id: Self::normalize_container_id(section_id),
            area_id: Self::normalize_container_id(area_id),
            include_target_containers: true,
            ..Self::default()
        }
    }
}

#[derive(Debug, Default)]
struct TaskMutationReadStats {
    statements: usize,
    rows: usize,
    task_rows: usize,
}

fn push_unique_entity(entities: &mut Vec<Value>, entity: Value) {
    let Some(id) = entity.get("id").and_then(Value::as_str) else {
        return;
    };
    if entities
        .iter()
        .any(|existing| existing.get("id").and_then(Value::as_str) == Some(id))
    {
        return;
    }
    entities.push(entity);
}

fn push_unique_id(ids: &mut Vec<String>, id: Option<&str>) {
    let Some(id) = id.map(str::trim).filter(|id| !id.is_empty()) else {
        return;
    };
    if !ids.iter().any(|existing| existing == id) {
        ids.push(id.to_string());
    }
}

fn read_scoped_task(
    conn: &Connection,
    task_id: &str,
    stats: &mut TaskMutationReadStats,
) -> Result<Option<Value>, String> {
    stats.statements += 1;
    let task = conn
        .query_row(
            "SELECT * FROM tasks WHERE id = ?1",
            [task_id],
            row_to_task_value,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if task.is_some() {
        stats.rows += 1;
        stats.task_rows += 1;
    }
    Ok(task)
}

fn load_scoped_project(
    conn: &Connection,
    project_id: &str,
    projects: &mut Vec<Value>,
    stats: &mut TaskMutationReadStats,
) -> Result<(), String> {
    if projects
        .iter()
        .any(|project| project.get("id").and_then(Value::as_str) == Some(project_id))
    {
        return Ok(());
    }
    stats.statements += 1;
    let project = conn
        .query_row(
            "SELECT * FROM projects WHERE id = ?1",
            [project_id],
            row_to_project_value,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(project) = project {
        stats.rows += 1;
        projects.push(project);
    }
    Ok(())
}

fn load_scoped_section(
    conn: &Connection,
    section_id: &str,
    sections: &mut Vec<Value>,
    stats: &mut TaskMutationReadStats,
) -> Result<Option<String>, String> {
    if let Some(section) = sections
        .iter()
        .find(|section| section.get("id").and_then(Value::as_str) == Some(section_id))
    {
        return Ok(section
            .get("projectId")
            .and_then(Value::as_str)
            .map(str::to_string));
    }
    stats.statements += 1;
    let section = conn
        .query_row(
            "SELECT * FROM sections WHERE id = ?1",
            [section_id],
            row_to_section_value,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(section) = section {
        stats.rows += 1;
        let project_id = section
            .get("projectId")
            .and_then(Value::as_str)
            .map(str::to_string);
        sections.push(section);
        return Ok(project_id);
    }
    Ok(None)
}

fn load_scoped_area(
    conn: &Connection,
    area_id: &str,
    areas: &mut Vec<Value>,
    stats: &mut TaskMutationReadStats,
) -> Result<(), String> {
    if areas
        .iter()
        .any(|area| area.get("id").and_then(Value::as_str) == Some(area_id))
    {
        return Ok(());
    }
    stats.statements += 1;
    let area = conn
        .query_row(
            "SELECT id, deletedAt FROM areas WHERE id = ?1",
            [area_id],
            |row| {
                let mut area = Map::new();
                area.insert("id".to_string(), Value::String(row.get("id")?));
                if let Some(deleted_at) = row.get::<_, Option<String>>("deletedAt")? {
                    area.insert("deletedAt".to_string(), Value::String(deleted_at));
                }
                Ok(Value::Object(area))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(area) = area {
        stats.rows += 1;
        areas.push(area);
    }
    Ok(())
}

fn append_scoped_task_rows<P>(
    conn: &Connection,
    sql: &str,
    params: P,
    tasks: &mut Vec<Value>,
    stats: &mut TaskMutationReadStats,
) -> Result<(), String>
where
    P: rusqlite::Params,
{
    stats.statements += 1;
    let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params, row_to_task_value)
        .map_err(|e| e.to_string())?;
    for row in rows {
        stats.rows += 1;
        stats.task_rows += 1;
        push_unique_entity(tasks, row.map_err(|e| e.to_string())?);
    }
    Ok(())
}

fn read_task_mutation_data(
    conn: &Connection,
    scope: &TaskMutationReadScope,
) -> Result<(Value, TaskMutationReadStats), String> {
    let mut stats = TaskMutationReadStats::default();
    let mut tasks = Vec::new();
    let mut projects = Vec::new();
    let mut sections = Vec::new();
    let mut areas = Vec::new();

    let target = if let Some(task_id) = scope.task_id.as_deref() {
        let task = read_scoped_task(conn, task_id, &mut stats)?;
        if let Some(task) = task.as_ref() {
            tasks.push(task.clone());
        }
        task
    } else {
        None
    };

    let mut project_ids = Vec::new();
    let mut section_ids = Vec::new();
    let mut area_ids = Vec::new();
    push_unique_id(&mut project_ids, scope.project_id.as_deref());
    push_unique_id(&mut section_ids, scope.section_id.as_deref());
    push_unique_id(&mut area_ids, scope.area_id.as_deref());
    if scope.include_target_containers {
        if let Some(task) = target.as_ref() {
            push_unique_id(
                &mut project_ids,
                task.get("projectId").and_then(Value::as_str),
            );
            push_unique_id(
                &mut section_ids,
                task.get("sectionId").and_then(Value::as_str),
            );
            push_unique_id(&mut area_ids, task.get("areaId").and_then(Value::as_str));
        }
    }

    let mut section_project_ids = Vec::new();
    for section_id in &section_ids {
        let project_id = load_scoped_section(conn, section_id, &mut sections, &mut stats)?;
        push_unique_id(&mut section_project_ids, project_id.as_deref());
    }
    for project_id in section_project_ids {
        push_unique_id(&mut project_ids, Some(&project_id));
    }
    for project_id in &project_ids {
        load_scoped_project(conn, project_id, &mut projects, &mut stats)?;
    }
    for area_id in &area_ids {
        load_scoped_area(conn, area_id, &mut areas, &mut stats)?;
    }

    // Project order is allocated from the destination's canonical rows while
    // the caller holds BEGIN IMMEDIATE. Concurrent Local API moves therefore
    // serialize their MAX+1 reservations instead of choosing the same slot.
    // Match core getProjectOrderIndex exactly: every non-deleted task in the
    // project counts, including sectioned tasks; the SQLite row stores the
    // synchronized order/orderNum aliases in orderNum.
    let requested_section_project_id = scope.section_id.as_deref().and_then(|section_id| {
        sections
            .iter()
            .find(|section| section.get("id").and_then(Value::as_str) == Some(section_id))
            .and_then(|section| section.get("projectId"))
            .and_then(Value::as_str)
    });
    let destination_project_id = scope.project_id.as_deref().or(requested_section_project_id);
    let current_project_id = target
        .as_ref()
        .and_then(|task| task.get("projectId"))
        .and_then(Value::as_str);
    let destination_next_order = if target.is_some()
        && destination_project_id.is_some()
        && destination_project_id != current_project_id
    {
        let project_id = destination_project_id.expect("checked above");
        stats.statements += 1;
        let max_order: Option<f64> = conn
            .query_row(
                "SELECT MAX(orderNum) FROM tasks
                 WHERE projectId = ?1
                   AND (deletedAt IS NULL OR trim(deletedAt) = '')",
                [project_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        stats.rows += 1;
        Some((
            project_id.to_string(),
            max_order.filter(|order| order.is_finite()).unwrap_or(-1.0) + 1.0,
        ))
    } else {
        None
    };

    stats.statements += 1;
    let settings_raw: Option<String> = conn
        .query_row("SELECT data FROM settings WHERE id = 1", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if settings_raw.is_some() {
        stats.rows += 1;
    }
    let settings = parse_json_value(settings_raw)
        .as_object()
        .cloned()
        .unwrap_or_default();

    let mut focused_count = None;
    if scope.include_focus_context {
        stats.statements += 1;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                   SELECT 1 FROM tasks
                   WHERE isFocusedToday = 1
                     AND (deletedAt IS NULL OR trim(deletedAt) = '')
                     AND status NOT IN ('done', 'reference')
                   LIMIT 10
                 )",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        stats.rows += 1;
        focused_count = Some(count.max(0) as u64);

        let focus_project_id = scope.project_id.as_deref().or_else(|| {
            scope.section_id.as_deref().and_then(|section_id| {
                sections
                    .iter()
                    .find(|section| section.get("id").and_then(Value::as_str) == Some(section_id))
                    .and_then(|section| section.get("projectId"))
                    .and_then(Value::as_str)
            })
        });
        if let Some(project_id) = focus_project_id {
            if let Some(project) = projects
                .iter()
                .find(|project| project.get("id").and_then(Value::as_str) == Some(project_id))
            {
                if project.get("isSequential").and_then(Value::as_bool) == Some(true) {
                    let section_scoped =
                        project.get("sequentialScope").and_then(Value::as_str) == Some("section");
                    if section_scoped {
                        if let Some(section_id) = scope.section_id.as_deref() {
                            append_scoped_task_rows(
                                conn,
                                "SELECT * FROM tasks
                                 WHERE projectId = ?1 AND sectionId = ?2
                                   AND (deletedAt IS NULL OR trim(deletedAt) = '')
                                   AND status IN ('inbox', 'next', 'waiting', 'someday')
                                   AND (isFocusedToday = 1 OR status = 'next' OR reviewAt IS NOT NULL)",
                                params![project_id, section_id],
                                &mut tasks,
                                &mut stats,
                            )?;
                        } else {
                            append_scoped_task_rows(
                                conn,
                                "SELECT * FROM tasks
                                 WHERE projectId = ?1 AND sectionId IS NULL
                                   AND (deletedAt IS NULL OR trim(deletedAt) = '')
                                   AND status IN ('inbox', 'next', 'waiting', 'someday')
                                   AND (isFocusedToday = 1 OR status = 'next' OR reviewAt IS NOT NULL)",
                                [project_id],
                                &mut tasks,
                                &mut stats,
                            )?;
                        }
                    } else {
                        append_scoped_task_rows(
                            conn,
                            "SELECT * FROM tasks
                             WHERE projectId = ?1
                               AND (deletedAt IS NULL OR trim(deletedAt) = '')
                               AND status IN ('inbox', 'next', 'waiting', 'someday')
                               AND (isFocusedToday = 1 OR status = 'next' OR reviewAt IS NOT NULL)",
                            [project_id],
                            &mut tasks,
                            &mut stats,
                        )?;
                    }
                }
            }
        }
    }

    let mut data = serde_json::json!({
        "tasks": tasks,
        "projects": projects,
        "sections": sections,
        "areas": areas,
        "people": [],
        "settings": Value::Object(settings),
    });
    if let Some(count) = focused_count {
        data.as_object_mut()
            .expect("scoped task data is an object")
            .insert(
                TASK_MUTATION_FOCUSED_COUNT_KEY.to_string(),
                Value::Number(count.into()),
            );
    }
    if let Some((project_id, next_order)) = destination_next_order {
        let mut orders = serde_json::Map::new();
        let order = serde_json::Number::from_f64(next_order)
            .ok_or_else(|| "Invalid destination task order".to_string())?;
        orders.insert(project_id, Value::Number(order));
        data.as_object_mut()
            .expect("scoped task data is an object")
            .insert(
                TASK_MUTATION_PROJECT_NEXT_ORDERS_KEY.to_string(),
                Value::Object(orders),
            );
    }
    Ok((data, stats))
}

fn ensure_task_mutation_storage_ready(app: &tauri::AppHandle) -> Result<(), String> {
    ensure_data_file(app)?;
    let conn = open_sqlite(app)?;
    let needs_first_load = !sqlite_has_any_data(&conn)?;
    drop(conn);
    if needs_first_load {
        load_data_snapshot(app)?;
    }
    Ok(())
}

pub(crate) fn mutate_task_rows_with_retries<T, F>(
    app: &tauri::AppHandle,
    scope: TaskMutationReadScope,
    mut mutate: F,
) -> Result<(T, Value), String>
where
    F: FnMut(&mut Value) -> Result<(T, Vec<Value>), String>,
{
    // Bootstrap/migrate once before entering the retry loop. Steady-state
    // mutations do not read the whole store here; each retry loads only the
    // task and supporting rows described by `scope` under BEGIN IMMEDIATE.
    ensure_task_mutation_storage_ready(app)?;
    let data_path = get_data_path(app);
    for attempt in 0..STORAGE_RETRY_ATTEMPTS {
        let conn = open_sqlite(app)?;
        match commit_task_row_mutation(&conn, &scope, &mut mutate) {
            Ok((result, fallback, _read_stats)) => {
                let canonical = match stable_sqlite_snapshot_with_version(&conn) {
                    Ok((canonical, data_version)) => {
                        publish_task_data_json(&conn, &data_path, canonical, data_version)
                    }
                    Err(error) => {
                        // The rows are durably committed. `fallback` is only a
                        // scoped response snapshot, so never publish it as the
                        // full recovery document; leave the previous data.json
                        // intact and avoid turning success into a caller retry.
                        log::warn!(
                            "Task mutation committed but canonical recovery refresh failed: {error}"
                        );
                        fallback
                    }
                };
                return Ok((result, canonical));
            }
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
    Err("Failed to mutate task rows".to_string())
}

fn commit_task_row_mutation<T, F>(
    conn: &Connection,
    scope: &TaskMutationReadScope,
    mutate: &mut F,
) -> Result<(T, Value, TaskMutationReadStats), String>
where
    F: FnMut(&mut Value) -> Result<(T, Vec<Value>), String>,
{
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let (mut canonical, read_stats) = read_task_mutation_data(conn, scope)?;
        let (result, changed_tasks) = mutate(&mut canonical)?;
        let mut written_ids = HashSet::new();
        for task in changed_tasks {
            let task_id = task
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| "Task id is required".to_string())?;
            if written_ids.insert(task_id.to_string()) {
                replace_task_row(conn, &task)?;
            }
        }
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok((result, canonical, read_stats))
    })();
    if result.is_err() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    result
}

#[tauri::command]
pub(crate) async fn save_task(
    app: tauri::AppHandle,
    task: Value,
    baseline_task: Option<Value>,
) -> Result<TaskSaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_sqlite(&app)?;
        persist_task_snapshot_result(&conn, &task, &get_data_path(&app), baseline_task.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSaveResult {
    committed: bool,
    canonical: Option<Value>,
    canonical_reload_required: bool,
}

fn persist_task_snapshot(
    conn: &Connection,
    task: &Value,
    data_path: &Path,
    baseline_task: Option<&Value>,
) -> Result<Value, String> {
    persist_task_snapshot_result(conn, task, data_path, baseline_task)?
        .canonical
        .ok_or_else(|| "Committed task snapshot requires a canonical reload".to_string())
}

fn persist_task_snapshot_result(
    conn: &Connection,
    task: &Value,
    data_path: &Path,
    baseline_task: Option<&Value>,
) -> Result<TaskSaveResult, String> {
    persist_task_snapshot_with_reader(conn, task, data_path, baseline_task, || {
        stable_sqlite_snapshot_with_version(conn)
    })
}

fn persist_task_snapshot_with_reader<F>(
    conn: &Connection,
    task: &Value,
    data_path: &Path,
    baseline_task: Option<&Value>,
    read_canonical: F,
) -> Result<TaskSaveResult, String>
where
    F: FnOnce() -> Result<(Value, i64), String>,
{
    commit_task_snapshot(conn, task, baseline_task)?;
    let (canonical, data_version) = match read_canonical() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            // COMMIT is the durable acknowledgement boundary. A recovery-copy
            // read after it may require a later reload, but must never turn the
            // completed mutation into a caller-visible failure and retry.
            log::warn!(
                "Task save committed but canonical recovery snapshot could not be read: {error}"
            );
            return Ok(TaskSaveResult {
                committed: true,
                canonical: None,
                canonical_reload_required: true,
            });
        }
    };
    Ok(TaskSaveResult {
        committed: true,
        canonical: Some(publish_task_data_json(
            conn,
            data_path,
            canonical,
            data_version,
        )),
        canonical_reload_required: false,
    })
}

fn commit_task_snapshot(
    conn: &Connection,
    task: &Value,
    baseline_task: Option<&Value>,
) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result: Result<(), String> = (|| {
        let task_id = task.get("id").and_then(Value::as_str);
        let was_observed = task_id.is_some()
            && task_id
                == baseline_task
                    .and_then(|baseline| baseline.get("id"))
                    .and_then(Value::as_str);
        let canonical_exists = if let Some(task_id) = task_id.filter(|_| was_observed) {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1)",
                [task_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?
        } else {
            true
        };
        if canonical_exists {
            upsert_task_row(conn, task)?;
        }
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    result
}

fn sqlite_data_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn stable_sqlite_snapshot_with_version(conn: &Connection) -> Result<(Value, i64), String> {
    stable_snapshot_with_version_readers(
        || sqlite_data_version(conn),
        || read_sqlite_snapshot(conn),
    )
}

fn stable_snapshot_with_version_readers<V, S>(
    mut read_version: V,
    mut read_snapshot: S,
) -> Result<(Value, i64), String>
where
    V: FnMut() -> Result<i64, String>,
    S: FnMut() -> Result<Value, String>,
{
    let mut last_read = None;
    for _ in 0..STORAGE_RETRY_ATTEMPTS {
        let before = read_version()?;
        let canonical = read_snapshot()?;
        let after = read_version()?;
        if before == after {
            return Ok((canonical, after));
        }
        // The snapshot is still transactionally consistent even when another
        // connection committed around it. Keep it as a successful post-commit
        // return value; using the older version as the publication expectation
        // forces data.json repair to retry rather than mistaking it for current.
        last_read = Some((canonical, before));
    }
    last_read.ok_or_else(|| "Could not read canonical SQLite snapshot".to_string())
}

fn publish_task_data_json(
    conn: &Connection,
    data_path: &Path,
    mut canonical: Value,
    mut expected_data_version: i64,
) -> Value {
    // Serialization, fsync, and atomic replacement happen after COMMIT, so an
    // incremental task save does one canonical read and never holds SQLite's
    // writer lock across filesystem I/O. If another connection commits before
    // publication finishes, reload and republish its newer canonical snapshot.
    write_data_json_best_effort(data_path, &canonical);
    for attempt in 0..STORAGE_RETRY_ATTEMPTS {
        let current_data_version = match sqlite_data_version(conn) {
            Ok(version) => version,
            Err(error) => {
                log::warn!("Could not verify data.json after task save: {error}");
                return canonical;
            }
        };
        if current_data_version == expected_data_version {
            return canonical;
        }
        if attempt + 1 == STORAGE_RETRY_ATTEMPTS {
            log::warn!("SQLite kept changing while refreshing data.json after task save");
            return canonical;
        }
        let (latest, latest_data_version) = match stable_sqlite_snapshot_with_version(conn) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                log::warn!("Could not reload data.json after concurrent task save: {error}");
                return canonical;
            }
        };
        canonical = latest;
        write_data_json_best_effort(data_path, &canonical);
        expected_data_version = latest_data_version;
    }
    canonical
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

fn format_snapshot_file_name(now: OffsetDateTime, collision: u32) -> String {
    let collision_suffix = if collision == 0 {
        String::new()
    } else {
        format!(".{collision}")
    };
    format!(
        "data.{:04}-{:02}-{:02}T{:02}-{:02}-{:02}.{:09}{}.snapshot.json",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.nanosecond(),
        collision_suffix
    )
}

fn write_new_data_snapshot(
    snapshot_dir: &Path,
    canonical: &Value,
    now: OffsetDateTime,
) -> Result<String, String> {
    let content = serde_json::to_string_pretty(canonical).map_err(|e| e.to_string())?;
    let mut temp_file = tempfile::Builder::new()
        .prefix(".mindwtr-snapshot-")
        .suffix(".tmp")
        .tempfile_in(snapshot_dir)
        .map_err(|e| e.to_string())?;
    temp_file
        .write_all(content.as_bytes())
        .and_then(|_| temp_file.as_file().sync_all())
        .map_err(|e| e.to_string())?;

    for collision in 0..u32::MAX {
        let file_name = format_snapshot_file_name(now, collision);
        let snapshot_path = snapshot_dir.join(&file_name);
        match temp_file.persist_noclobber(&snapshot_path) {
            Ok(_) => {
                sync_parent_directory(&snapshot_path)?;
                return Ok(file_name);
            }
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                temp_file = error.file;
            }
            Err(error) => return Err(error.error.to_string()),
        }
    }
    Err("Failed to allocate a unique snapshot file name".to_string())
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

fn snapshot_matches_data(snapshot_path: &Path, canonical: &Value) -> bool {
    read_json_with_retries(snapshot_path, 1).is_ok_and(|snapshot| snapshot == *canonical)
}

fn create_data_snapshot_from_connection(
    conn: &Connection,
    snapshot_dir: &Path,
    now: OffsetDateTime,
) -> Result<String, String> {
    let canonical = read_sqlite_snapshot(conn)?;

    fs::create_dir_all(snapshot_dir).map_err(|e| e.to_string())?;
    if let Some((latest_name, latest_path, _)) = list_snapshot_entries(snapshot_dir).first() {
        if snapshot_matches_data(latest_path, &canonical) {
            prune_data_snapshots(snapshot_dir);
            return Ok(latest_name.clone());
        }
    }

    let file_name = write_new_data_snapshot(snapshot_dir, &canonical, now)?;
    prune_data_snapshots(snapshot_dir);
    Ok(file_name)
}

#[tauri::command(async)]
pub(crate) fn create_data_snapshot(app: tauri::AppHandle) -> Result<String, String> {
    let _snapshot_guard = lock_snapshot_operation()?;
    load_data_snapshot(&app)?;
    let conn = open_sqlite(&app)?;
    let snapshot_dir = get_snapshot_dir(&app)?;
    create_data_snapshot_from_connection(&conn, &snapshot_dir, OffsetDateTime::now_utc())
}

// Directory listing only: new snapshot files land via atomic rename
// (write_new_data_snapshot) and prune's own file-not-found races are already
// silently ignored, so this doesn't need the create/restore lock.
#[tauri::command(async)]
pub(crate) fn list_data_snapshots(app: tauri::AppHandle) -> Result<Vec<String>, String> {
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

#[tauri::command(async)]
pub(crate) fn restore_data_snapshot(
    app: tauri::AppHandle,
    snapshot_file_name: String,
) -> Result<bool, String> {
    let _snapshot_guard = lock_snapshot_operation()?;
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
    persist_data_snapshot_exact_with_retries(&app, &data)?;
    Ok(true)
}

#[tauri::command(async)]
pub(crate) fn query_tasks(
    app: tauri::AppHandle,
    options: TaskQueryOptions,
) -> Result<Vec<Value>, String> {
    let conn = open_sqlite(&app)?;
    query_tasks_with_connection(&conn, &options)
}

// Lifted out of the #[tauri::command] closure so it's callable from a test with a plain
// in-memory Connection - the command itself needs an AppHandle just to open the real db.
fn query_tasks_with_connection(
    conn: &Connection,
    options: &TaskQueryOptions,
) -> Result<Vec<Value>, String> {
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

    // COALESCE, not `= ?`: the column is nullable, and rows written before the field
    // existed store NULL rather than 0 (mirrors buildTaskWhere in packages/core).
    if let Some(is_focused_today) = options.is_focused_today {
        where_clauses.push("COALESCE(isFocusedToday, 0) = ?".to_string());
        params.push(Box::new(if is_focused_today { 1i64 } else { 0i64 }));
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

#[tauri::command(async)]
pub(crate) fn search_fts(app: tauri::AppHandle, query: String) -> Result<Value, String> {
    let mut conn = open_sqlite(&app)?;
    search_fts_with_connection(&mut conn, &query)
}

fn search_fts_with_connection(conn: &mut Connection, query: &str) -> Result<Value, String> {
    let Some(fts_query) = build_fts_query(&query) else {
        return Ok(serde_json::json!({ "tasks": [], "projects": [] }));
    };
    ensure_fts_ready(conn)?;

    let mut tasks: Vec<Value> = Vec::new();
    let mut projects: Vec<Value> = Vec::new();
    let mut limited = false;

    let mut task_stmt = conn
        .prepare("SELECT t.* FROM tasks_fts f JOIN tasks t ON f.rowid = t.rowid WHERE tasks_fts MATCH ?1 AND t.deletedAt IS NULL LIMIT ?2")
        .map_err(|e| e.to_string())?;
    let task_rows = task_stmt
        .query_map(
            params![fts_query.clone(), SEARCH_RESULT_QUERY_LIMIT],
            |row| row_to_task_value(row),
        )
        .map_err(|e| e.to_string())?;
    for row in task_rows {
        let value = row.map_err(|e| e.to_string())?;
        if tasks.len() < SEARCH_RESULT_LIMIT {
            tasks.push(value);
        } else {
            limited = true;
        }
    }

    let mut project_stmt = conn
        .prepare("SELECT p.* FROM projects_fts f JOIN projects p ON f.rowid = p.rowid WHERE projects_fts MATCH ?1 AND p.deletedAt IS NULL LIMIT ?2")
        .map_err(|e| e.to_string())?;
    let project_rows = project_stmt
        .query_map(params![fts_query, SEARCH_RESULT_QUERY_LIMIT], |row| {
            row_to_project_value(row)
        })
        .map_err(|e| e.to_string())?;
    for row in project_rows {
        let value = row.map_err(|e| e.to_string())?;
        if projects.len() < SEARCH_RESULT_LIMIT {
            projects.push(value);
        } else {
            limited = true;
        }
    }

    Ok(serde_json::json!({
        "tasks": tasks,
        "projects": projects,
        "limited": if limited { Some(true) } else { None },
        "limit": if limited { Some(SEARCH_RESULT_LIMIT) } else { None }
    }))
}

#[tauri::command]
pub(crate) fn get_data_path_cmd(app: tauri::AppHandle) -> String {
    get_data_path(&app).to_string_lossy().to_string()
}

#[tauri::command]
pub(crate) fn get_db_path_cmd(app: tauri::AppHandle) -> String {
    get_db_path(&app).to_string_lossy().to_string()
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::{Arc, Barrier};

    // The three retry loops in this file gate entirely on this classifier, and
    // it matches on message text — so pin it against the strings SQLite really
    // produces, not against strings someone wrote from memory.
    #[test]
    fn classifies_a_real_contended_sqlite_write_as_retryable() {
        let temp = tempfile::tempdir().expect("should create temp dir");
        let db_path = temp.path().join("contended.db");

        let holder = Connection::open(&db_path).expect("should open the holding connection");
        holder
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER);")
            .expect("should initialize the database");
        let blocked = Connection::open(&db_path).expect("should open the blocked connection");
        blocked
            .busy_timeout(Duration::from_millis(0))
            .expect("should disable the busy timeout");

        holder
            .execute_batch("BEGIN EXCLUSIVE;")
            .expect("should take the write lock");
        let error = blocked
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO t VALUES (1); COMMIT;")
            .expect_err("the second writer should be locked out")
            .to_string();

        assert!(
            is_retryable_storage_error(&error),
            "a contended write should be retryable, got {error:?}"
        );
    }

    #[test]
    fn classifies_sqlite_lock_codes_as_retryable_and_real_faults_as_final() {
        // rusqlite renders a bare result code as "Error code N: <errstr>".
        let busy = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(5), None).to_string();
        let locked = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(6), None).to_string();
        assert!(is_retryable_storage_error(&busy), "SQLITE_BUSY: {busy:?}");
        assert!(
            is_retryable_storage_error(&locked),
            "SQLITE_LOCKED: {locked:?}"
        );
        assert!(is_retryable_storage_error("Resource busy"));
        assert!(is_retryable_storage_error(
            "Resource temporarily unavailable (os error 11)"
        ));

        // Retrying these only delays the error the caller has to see.
        assert!(!is_retryable_storage_error("no such table: tasks"));
        assert!(!is_retryable_storage_error("unable to open database file"));
        assert!(!is_retryable_storage_error("disk I/O error"));
        assert!(!is_retryable_storage_error("database disk image is malformed"));
        assert!(!is_retryable_storage_error(""));
    }

    #[test]
    fn rust_task_mapper_matches_core_schema_fixture() {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/task-sync-schema.fixture.json"
        ))
        .expect("valid Task schema fixture");
        let fields = schema
            .get("fields")
            .and_then(Value::as_array)
            .expect("Task schema fields");
        let fixture = schema.get("fixture").expect("Task schema payload");

        let mut expected_keys: Vec<String> = fields
            .iter()
            .map(|field| {
                field
                    .get("name")
                    .and_then(Value::as_str)
                    .expect("Task schema field name")
                    .to_string()
            })
            .collect();
        expected_keys.sort();

        let mut fixture_keys: Vec<String> = fixture
            .as_object()
            .expect("Task schema fixture object")
            .keys()
            .cloned()
            .collect();
        fixture_keys.sort();
        assert_eq!(
            fixture_keys, expected_keys,
            "fixture must cover every Task field"
        );

        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        conn.execute_batch("PRAGMA foreign_keys = OFF;")
            .expect("should disable fixture foreign keys");
        upsert_task_row(&conn, fixture).expect("should write exhaustive Task fixture");

        let task_id = fixture
            .get("id")
            .and_then(Value::as_str)
            .expect("Task fixture id");
        let mapped = conn
            .query_row(
                "SELECT * FROM tasks WHERE id = ?1",
                [task_id],
                row_to_task_value,
            )
            .expect("should map exhaustive Task row");
        let mut actual_keys: Vec<String> = mapped
            .as_object()
            .expect("mapped Task object")
            .keys()
            .cloned()
            .collect();
        actual_keys.sort();

        assert_eq!(
            actual_keys, expected_keys,
            "Rust row_to_task_value must return every core Task field"
        );
        assert_eq!(
            &mapped, fixture,
            "Rust Task mapper must preserve every shared fixture value"
        );
    }

    /// The canonical wire form of `showFutureRecurrence` is `true` or ABSENT,
    /// never `false` (the merge rule in packages/core/src/sync-normalization.ts).
    /// This reader and the JS codec's `fromPresentBool` must agree, or a desktop
    /// build's two local readers disagree about the same row and the sync cycle
    /// re-normalizes the whole library on every upload. The JS side of the same
    /// rule is pinned by packages/core/src/sync-schema-row-codec.test.ts (sparse
    /// task fixture) and packages/core/src/sync-canonical-reads.contract.test.ts.
    #[test]
    fn show_future_recurrence_round_trips_as_true_or_absent() {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/task-sync-schema.fixture.json"
        ))
        .expect("valid Task schema fixture");
        let fixture = schema
            .get("fixture")
            .and_then(Value::as_object)
            .expect("Task schema payload")
            .clone();

        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        conn.execute_batch("PRAGMA foreign_keys = OFF;")
            .expect("should disable fixture foreign keys");

        let write = |id: &str, value: Option<bool>| {
            let mut task = fixture.clone();
            task.insert("id".to_string(), Value::String(id.to_string()));
            match value {
                Some(flag) => {
                    task.insert("showFutureRecurrence".to_string(), Value::Bool(flag));
                }
                None => {
                    task.remove("showFutureRecurrence");
                }
            }
            upsert_task_row(&conn, &Value::Object(task)).expect("should write task row");
        };
        let read = |id: &str| -> Option<Value> {
            conn.query_row("SELECT * FROM tasks WHERE id = ?1", [id], row_to_task_value)
                .expect("should map task row")
                .get("showFutureRecurrence")
                .cloned()
        };

        write("sfr-true", Some(true));
        write("sfr-false", Some(false));
        write("sfr-absent", None);

        assert_eq!(read("sfr-true"), Some(Value::Bool(true)));
        // Stored 0, and every legacy row already on disk, read back ABSENT.
        assert_eq!(read("sfr-false"), None);
        assert_eq!(read("sfr-absent"), None);
    }

    /// Mirrors `packages/core/src/task-query.test.ts` and `local_api.rs`'s
    /// fixture test against the SAME (tasks, query) -> expected ids table.
    /// Unlike local_api's HTTP-query-param filter, this Tauri command takes a
    /// JSON body shaped exactly like core's `TaskQueryOptions`, so every case
    /// in the fixture is expressible here - none are skipped.
    #[test]
    fn query_tasks_with_connection_matches_task_query_fixture() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/task-query.fixtures.json"
        ))
        .expect("valid task query fixture");
        let cases = cases.as_array().expect("fixture array");
        assert!(!cases.is_empty(), "expected at least one fixture case");

        for test_case in cases {
            let name = test_case
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unnamed task query case");
            let conn = Connection::open_in_memory().expect("should open in-memory db");
            conn.execute_batch(SQLITE_SCHEMA)
                .expect("should create schema");
            // No upsert_project_row helper exists (this file only writes tasks) - the
            // "projectId filters to one project" case references projects that are never
            // inserted, so drop FK enforcement for this test the same way the exhaustive
            // single-task fixture test above does.
            conn.execute_batch("PRAGMA foreign_keys = OFF;")
                .expect("should disable fixture foreign keys");

            for task in test_case
                .get("tasks")
                .and_then(Value::as_array)
                .unwrap_or_else(|| panic!("missing tasks array for {name}"))
            {
                upsert_task_row(&conn, task)
                    .unwrap_or_else(|error| panic!("seeding task failed for {name}: {error}"));
            }

            let options: TaskQueryOptions = serde_json::from_value(
                test_case
                    .get("query")
                    .cloned()
                    .unwrap_or(serde_json::json!({})),
            )
            .unwrap_or_else(|error| panic!("invalid query descriptor for {name}: {error}"));
            let expected_ids: Vec<String> = test_case
                .get("expectedIds")
                .and_then(Value::as_array)
                .unwrap_or_else(|| panic!("missing expectedIds for {name}"))
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect();

            let filtered = query_tasks_with_connection(&conn, &options).unwrap_or_else(|error| {
                panic!("query_tasks_with_connection failed for {name}: {error}")
            });
            let mut ids: Vec<String> = filtered
                .iter()
                .filter_map(|task| task.get("id").and_then(Value::as_str).map(str::to_string))
                .collect();
            ids.sort();
            let mut expected_ids = expected_ids;
            expected_ids.sort();
            assert_eq!(ids, expected_ids, "{name}");
        }
    }

    #[test]
    fn detect_storage_mode_returns_standard_without_marker() {
        let exe_dir = std::env::temp_dir().join("mindwtr-portable-mode-without-marker");

        let mode = detect_storage_mode_from_exe_dir(Some(&exe_dir));

        assert_eq!(mode, StorageMode::Standard);
    }

    #[test]
    fn empty_leftover_directory_is_removed() {
        let parent = tempfile::tempdir().expect("should create temp parent");
        let target = parent.path().join("mindwtr-empty");
        fs::create_dir(&target).expect("should create target dir");

        assert!(remove_dir_if_empty(&target));
        assert!(!target.exists());
    }

    #[test]
    fn directory_holding_anything_is_left_alone() {
        // The whole point of remove_dir over remove_dir_all: if another component
        // has written into the OS config dir, the cleanup must not take it.
        let parent = tempfile::tempdir().expect("should create temp parent");
        let target = parent.path().join("mindwtr-occupied");
        fs::create_dir(&target).expect("should create target dir");
        let occupant = target.join("someone-elses.json");
        fs::write(&occupant, b"{}").expect("should write occupant file");

        assert!(!remove_dir_if_empty(&target));
        assert!(target.exists());
        assert!(occupant.exists());
    }

    #[test]
    fn missing_directory_is_not_an_error() {
        let parent = tempfile::tempdir().expect("should create temp parent");

        assert!(!remove_dir_if_empty(&parent.path().join("never-created")));
    }

    #[test]
    fn bootstrap_publication_replaces_partial_but_preserves_valid_data() {
        let temp = tempfile::tempdir().expect("data directory");
        let partial_path = temp.path().join("partial.json");
        fs::write(&partial_path, b"{\"tasks\":[").expect("partial legacy write");
        let initial = serde_json::json!({
            "tasks": [], "projects": [], "sections": [], "areas": [], "people": [],
            "settings": { "theme": "dark" }
        });

        assert!(write_initial_data_json_file(&partial_path, &initial)
            .expect("replace partial atomically"));
        assert_eq!(
            read_json_with_retries(&partial_path, 1).expect("valid replacement"),
            initial
        );

        let existing_path = temp.path().join("existing.json");
        let existing = serde_json::json!({
            "tasks": [], "projects": [], "sections": [], "areas": [], "people": [],
            "settings": { "theme": "light" }
        });
        write_data_json_file(&existing_path, &existing).expect("existing valid data");
        assert!(!write_initial_data_json_file(&existing_path, &initial)
            .expect("valid final wins no-clobber race"));
        assert_eq!(
            read_json_with_retries(&existing_path, 1).expect("preserved existing"),
            existing
        );
    }

    #[test]
    fn detect_storage_mode_returns_portable_when_marker_exists() {
        let exe_dir = tempfile::tempdir().expect("should create temp exe dir");
        let marker_path = exe_dir.path().join(PORTABLE_MARKER_FILE_NAME);
        fs::write(&marker_path, b"portable").expect("should write portable marker");

        let mode = detect_storage_mode_from_exe_dir(Some(exe_dir.path()));

        assert_eq!(
            mode,
            StorageMode::Portable {
                profile_root: exe_dir.path().join(PORTABLE_PROFILE_DIR_NAME),
            }
        );
    }

    #[test]
    fn portable_profile_root_is_nested_under_executable_dir() {
        let exe_dir = std::env::temp_dir().join("mindwtr-portable");

        assert_eq!(
            portable_profile_root_for_exe_dir(&exe_dir),
            exe_dir.join(PORTABLE_PROFILE_DIR_NAME)
        );
    }

    #[test]
    fn ensure_projects_due_date_column_migrates_legacy_schema_before_indexing() {
        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE projects (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              status TEXT NOT NULL,
              color TEXT NOT NULL
            );
            "#,
        )
        .expect("should create legacy projects table");

        ensure_projects_due_date_column(&conn).expect("should add dueDate column and index");

        let mut stmt = conn
            .prepare("PRAGMA table_info(projects)")
            .expect("should inspect project columns");
        let column_names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("should read project columns")
            .map(|row| row.expect("column row"))
            .collect();
        assert!(column_names.iter().any(|name| name == "dueDate"));

        let mut idx_stmt = conn
            .prepare("PRAGMA index_list(projects)")
            .expect("should inspect project indexes");
        let index_names: Vec<String> = idx_stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("should read project indexes")
            .map(|row| row.expect("index row"))
            .collect();
        assert!(index_names
            .iter()
            .any(|name| name == "idx_projects_dueDate"));
    }

    #[test]
    fn ensure_projects_purged_at_column_migrates_legacy_schema() {
        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE projects (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              status TEXT NOT NULL,
              color TEXT NOT NULL
            );
            "#,
        )
        .expect("should create legacy projects table");

        ensure_projects_purged_at_column(&conn).expect("should add purgedAt column");

        let mut stmt = conn
            .prepare("PRAGMA table_info(projects)")
            .expect("should inspect project columns");
        let column_names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("should read project columns")
            .map(|row| row.expect("column row"))
            .collect();
        assert!(column_names.iter().any(|name| name == "purgedAt"));
    }

    #[test]
    fn ensure_tasks_organization_indexes_create_energy_and_assignee_indexes() {
        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE tasks (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              status TEXT NOT NULL,
              energyLevel TEXT,
              assignedTo TEXT
            );
            "#,
        )
        .expect("should create tasks table");

        ensure_tasks_organization_indexes(&conn).expect("should create task organization indexes");

        let mut stmt = conn
            .prepare("PRAGMA index_list(tasks)")
            .expect("should inspect task indexes");
        let index_names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("should read task indexes")
            .map(|row| row.expect("index row"))
            .collect();
        assert!(index_names
            .iter()
            .any(|name| name == "idx_tasks_energyLevel"));
        assert!(index_names
            .iter()
            .any(|name| name == "idx_tasks_assignedTo"));
    }

    #[test]
    fn refuses_empty_snapshot_over_existing_entities() {
        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let task = serde_json::json!({
            "id": "task-guard-1",
            "title": "Existing task",
            "status": "next",
            "createdAt": "2026-07-01T00:00:00.000Z",
            "updatedAt": "2026-07-01T00:00:00.000Z"
        });
        upsert_task_row(&conn, &task).expect("should upsert task");

        let empty = serde_json::json!({
            "tasks": [],
            "projects": [],
            "settings": {"theme": "dark"}
        });
        let result = refuse_empty_snapshot_overwrite(&conn, &empty, None);
        assert!(
            result.is_err(),
            "empty payload over live data must be refused"
        );

        // Mass deletions keep tombstoned rows, so a payload that still carries
        // the (deleted) entity is a legitimate overwrite.
        let tombstoned = serde_json::json!({
            "tasks": [{
                "id": "task-guard-1",
                "title": "Existing task",
                "status": "next",
                "createdAt": "2026-07-01T00:00:00.000Z",
                "updatedAt": "2026-07-02T00:00:00.000Z",
                "deletedAt": "2026-07-02T00:00:00.000Z"
            }],
            "projects": []
        });
        refuse_empty_snapshot_overwrite(&conn, &tombstoned, None)
            .expect("tombstone-carrying payload should pass");

        let baseline = serde_json::json!({ "tasks": [task] });
        refuse_empty_snapshot_overwrite(&conn, &empty, Some(&baseline))
            .expect("an observed omission is guarded by the transactional row CAS");
        refuse_empty_snapshot_overwrite(&conn, &empty, Some(&serde_json::json!({})))
            .expect("an empty CAS baseline cannot remove unobserved canonical rows");
    }

    #[test]
    fn allows_empty_snapshot_on_fresh_database() {
        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        // Fresh installs persist settings-only documents before any task exists.
        let empty = serde_json::json!({
            "tasks": [],
            "projects": [],
            "settings": {"language": "en"}
        });
        refuse_empty_snapshot_overwrite(&conn, &empty, None)
            .expect("settings-only save on a fresh database should pass");
    }

    #[test]
    fn counts_incoming_entities_across_all_collections() {
        assert_eq!(count_incoming_entities(&serde_json::json!({})), 0);
        assert_eq!(
            count_incoming_entities(&serde_json::json!({
                "tasks": [{"id": "t"}],
                "people": [{"id": "p"}, {"id": "q"}]
            })),
            3
        );
    }

    #[test]
    fn sqlite_round_trip_preserves_fractional_sort_orders() {
        // Sparse reorders and other devices can produce fractional orders; binding
        // them as i64 used to store NULL and drop the task to the bottom after the
        // next sync reload (#784).
        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let task = serde_json::json!({
            "id": "task-fractional-order",
            "title": "Dragged task",
            "status": "next",
            "order": 1536.5,
            "boardOrder": 12.25,
            "createdAt": "2026-05-01T00:00:00.000Z",
            "updatedAt": "2026-05-22T00:00:00.000Z"
        });

        upsert_task_row(&conn, &task).expect("should upsert task");
        let round_tripped = read_sqlite_data(&conn).expect("should read sqlite data");
        let task = round_tripped
            .get("tasks")
            .and_then(|value| value.as_array())
            .and_then(|tasks| tasks.first())
            .expect("should read task");

        assert_eq!(task.get("order").and_then(|v| v.as_f64()), Some(1536.5));
        assert_eq!(task.get("orderNum").and_then(|v| v.as_f64()), Some(1536.5));
        assert_eq!(task.get("boardOrder").and_then(|v| v.as_f64()), Some(12.25));
    }

    #[test]
    fn sqlite_task_upsert_preserves_sync_metadata_fields() {
        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let task = serde_json::json!({
            "id": "task-upsert-1",
            "title": "Archived upsert task",
            "status": "archived",
            "description": "body",
            "textDirection": "rtl",
            "order": 7,
            "isFocusedToday": false,
            "suppressMindwtrReminders": false,
            "statusBeforeProjectArchive": "next",
            "completedAtBeforeProjectArchive": "2026-05-20T00:00:00.000Z",
            "isFocusedTodayBeforeProjectArchive": true,
            "projectArchivedAt": "2026-05-21T00:00:00.000Z",
            "createdAt": "2026-05-01T00:00:00.000Z",
            "updatedAt": "2026-05-22T00:00:00.000Z"
        });

        upsert_task_row(&conn, &task).expect("should upsert task");
        let round_tripped = read_sqlite_data(&conn).expect("should read sqlite data");
        let task = round_tripped
            .get("tasks")
            .and_then(|value| value.as_array())
            .and_then(|tasks| tasks.first())
            .expect("should read task");

        assert_eq!(
            task.get("textDirection"),
            Some(&Value::String("rtl".into()))
        );
        assert_eq!(task.get("order"), Some(&Value::Number(7.into())));
        assert_eq!(task.get("orderNum"), Some(&Value::Number(7.into())));
        assert_eq!(task.get("isFocusedToday"), Some(&Value::Bool(false)));
        assert_eq!(
            task.get("suppressMindwtrReminders"),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            task.get("statusBeforeProjectArchive"),
            Some(&Value::String("next".into()))
        );
        assert_eq!(
            task.get("completedAtBeforeProjectArchive"),
            Some(&Value::String("2026-05-20T00:00:00.000Z".into()))
        );
        assert_eq!(
            task.get("isFocusedTodayBeforeProjectArchive"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            task.get("projectArchivedAt"),
            Some(&Value::String("2026-05-21T00:00:00.000Z".into()))
        );
    }

    #[test]
    fn sqlite_round_trip_preserves_sync_metadata_fields() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        ensure_column(&conn, "tasks", "textDirection", "TEXT").expect("should add textDirection");
        ensure_column(&conn, "tasks", "statusBeforeProjectArchive", "TEXT")
            .expect("should add archived status");
        ensure_column(&conn, "tasks", "completedAtBeforeProjectArchive", "TEXT")
            .expect("should add archived completedAt");
        ensure_column(
            &conn,
            "tasks",
            "isFocusedTodayBeforeProjectArchive",
            "INTEGER",
        )
        .expect("should add archived focus flag");
        ensure_column(&conn, "tasks", "projectArchivedAt", "TEXT")
            .expect("should add project archived time");
        ensure_column(&conn, "sections", "deletedAtBeforeProjectArchive", "TEXT")
            .expect("should add section archived delete time");
        ensure_column(&conn, "sections", "projectArchivedAt", "TEXT")
            .expect("should add section project archived time");
        ensure_column(&conn, "areas", "deletedAtBeforeProjectArchive", "TEXT")
            .expect("should add area archived delete time");
        ensure_column(&conn, "areas", "projectArchivedAt", "TEXT")
            .expect("should add area project archived time");
        ensure_column(&conn, "projects", "taskSortBy", "TEXT")
            .expect("should add project task sort");

        let source = serde_json::json!({
            "tasks": [{
                "id": "task-1",
                "title": "Archived task",
                "status": "archived",
                "tags": [],
                "contexts": [],
                "description": "body",
                "textDirection": "rtl",
                "order": 11,
                "showFutureRecurrence": false,
                "isFocusedToday": false,
                "suppressMindwtrReminders": false,
                "statusBeforeProjectArchive": "waiting",
                "completedAtBeforeProjectArchive": "2026-05-20T00:00:00.000Z",
                "isFocusedTodayBeforeProjectArchive": false,
                "projectArchivedAt": "2026-05-21T00:00:00.000Z",
                "createdAt": "2026-05-01T00:00:00.000Z",
                "updatedAt": "2026-05-22T00:00:00.000Z"
            }],
            "projects": [{
                "id": "project-1",
                "title": "Project",
                "status": "active",
                "color": "#6B7280",
                "order": 1,
                "tagIds": [],
                "isSequential": false,
                "isFocused": false,
                "createdAt": "2026-05-01T00:00:00.000Z",
                "updatedAt": "2026-05-22T00:00:00.000Z",
                "deletedAt": "2026-05-23T00:00:00.000Z",
                "purgedAt": "2026-05-24T00:00:00.000Z"
            }],
            "sections": [{
                "id": "section-1",
                "projectId": "project-1",
                "title": "Archived section",
                "order": 1,
                "isCollapsed": false,
                "createdAt": "2026-05-01T00:00:00.000Z",
                "updatedAt": "2026-05-22T00:00:00.000Z",
                "deletedAt": "2026-05-23T00:00:00.000Z",
                "deletedAtBeforeProjectArchive": "2026-05-20T00:00:00.000Z",
                "projectArchivedAt": "2026-05-21T00:00:00.000Z"
            }],
            "areas": [{
                "id": "area-1",
                "name": "Archived area",
                "order": 1,
                "createdAt": "2026-05-01T00:00:00.000Z",
                "updatedAt": "2026-05-22T00:00:00.000Z",
                "deletedAt": "2026-05-23T00:00:00.000Z",
                "deletedAtBeforeProjectArchive": "2026-05-20T00:00:00.000Z",
                "projectArchivedAt": "2026-05-21T00:00:00.000Z"
            }],
            "people": [],
            "settings": {}
        });

        migrate_json_to_sqlite(&mut conn, &source).expect("should migrate to sqlite");
        let round_tripped = read_sqlite_data(&conn).expect("should read sqlite data");
        let task = round_tripped
            .get("tasks")
            .and_then(|value| value.as_array())
            .and_then(|tasks| tasks.first())
            .expect("should read task");
        assert_eq!(
            task.get("textDirection"),
            Some(&Value::String("rtl".into()))
        );
        assert_eq!(task.get("order"), Some(&Value::Number(11.into())));
        assert_eq!(task.get("orderNum"), Some(&Value::Number(11.into())));
        // Stored 0 reads back ABSENT: canonical is `true` or nothing.
        assert_eq!(task.get("showFutureRecurrence"), None);
        assert_eq!(task.get("isFocusedToday"), Some(&Value::Bool(false)));
        assert_eq!(
            task.get("suppressMindwtrReminders"),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            task.get("statusBeforeProjectArchive"),
            Some(&Value::String("waiting".into()))
        );
        assert_eq!(
            task.get("completedAtBeforeProjectArchive"),
            Some(&Value::String("2026-05-20T00:00:00.000Z".into()))
        );
        assert_eq!(
            task.get("isFocusedTodayBeforeProjectArchive"),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            task.get("projectArchivedAt"),
            Some(&Value::String("2026-05-21T00:00:00.000Z".into()))
        );

        let project = round_tripped
            .get("projects")
            .and_then(|value| value.as_array())
            .and_then(|projects| projects.first())
            .expect("should read project");
        assert_eq!(project.get("isSequential"), Some(&Value::Bool(false)));
        assert_eq!(project.get("isFocused"), Some(&Value::Bool(false)));
        assert_eq!(
            project.get("deletedAt"),
            Some(&Value::String("2026-05-23T00:00:00.000Z".into()))
        );
        assert_eq!(
            project.get("purgedAt"),
            Some(&Value::String("2026-05-24T00:00:00.000Z".into()))
        );

        let section = round_tripped
            .get("sections")
            .and_then(|value| value.as_array())
            .and_then(|sections| sections.first())
            .expect("should read section");
        assert_eq!(section.get("isCollapsed"), Some(&Value::Bool(false)));
        assert_eq!(
            section.get("deletedAtBeforeProjectArchive"),
            Some(&Value::String("2026-05-20T00:00:00.000Z".into()))
        );
        assert_eq!(
            section.get("projectArchivedAt"),
            Some(&Value::String("2026-05-21T00:00:00.000Z".into()))
        );

        let area = round_tripped
            .get("areas")
            .and_then(|value| value.as_array())
            .and_then(|areas| areas.first())
            .expect("should read area");
        assert_eq!(
            area.get("deletedAtBeforeProjectArchive"),
            Some(&Value::String("2026-05-20T00:00:00.000Z".into()))
        );
        assert_eq!(
            area.get("projectArchivedAt"),
            Some(&Value::String("2026-05-21T00:00:00.000Z".into()))
        );
    }

    #[test]
    fn sqlite_round_trip_preserves_fully_populated_task_and_project_fields() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        ensure_column(&conn, "projects", "taskSortBy", "TEXT")
            .expect("should add project task sort");

        let task = serde_json::json!({
            "id": "task-full",
            "title": "Full task",
            "status": "completed",
            "priority": "high",
            "energyLevel": "medium",
            "assignedTo": "person-1",
            "taskMode": "deep",
            "startTime": "2026-06-01T08:30:00.000Z",
            "relativeStartOffset": {
                "amount": -2,
                "unit": "day"
            },
            "dueDate": "2026-06-02T12:00:00.000Z",
            "recurrence": {
                "type": "weekly",
                "interval": 2,
                "weekdays": [1, 3]
            },
            "showFutureRecurrence": true,
            "pushCount": 3,
            "tags": ["tag-1", "tag-2"],
            "contexts": ["context-1"],
            "checklist": [{
                "id": "check-1",
                "title": "Check one",
                "isCompleted": false
            }],
            "description": "Task body",
            "textDirection": "rtl",
            "attachments": [{
                "id": "task-attachment-1",
                "kind": "file",
                "title": "task.pdf",
                "uri": "file:///task.pdf",
                "cloudKey": "attachments/task.pdf",
                "localStatus": "available",
                "createdAt": "2026-06-01T08:00:00.000Z",
                "updatedAt": "2026-06-01T08:00:00.000Z"
            }],
            "location": "Office",
            "projectId": "project-full",
            "sectionId": "section-1",
            "viewSectionIds": {
                "someday": "someday-books",
                "future-scope": "future-heading"
            },
            "areaId": "area-1",
            "order": 17,
            "boardOrder": 4,
            "focusOrder": 2,
            "isFocusedToday": true,
            "timeEstimate": "45m",
            "timeSpentMinutes": 95,
            "suppressMindwtrReminders": true,
            "repeatReminderMinutes": 15,
            "reviewAt": "2026-06-03T09:00:00.000Z",
            "completedAt": "2026-06-04T10:00:00.000Z",
            "statusBeforeProjectArchive": "next",
            "completedAtBeforeProjectArchive": "2026-06-05T10:00:00.000Z",
            "isFocusedTodayBeforeProjectArchive": false,
            "projectArchivedAt": "2026-06-06T10:00:00.000Z",
            "rev": 42,
            "revBy": "device-a",
            "createdAt": "2026-06-01T08:00:00.000Z",
            "updatedAt": "2026-06-07T08:00:00.000Z",
            "deletedAt": "2026-06-08T08:00:00.000Z",
            "purgedAt": "2026-06-09T08:00:00.000Z"
        });
        let project = serde_json::json!({
            "id": "project-full",
            "title": "Full project",
            "status": "waiting",
            "color": "#2563eb",
            "order": 9,
            "tagIds": ["tag-1"],
            "isSequential": true,
            "sequentialScope": "section",
            "taskSortBy": "due",
            "isFocused": true,
            "supportNotes": "Project notes",
            "attachments": [{
                "id": "project-attachment-1",
                "kind": "file",
                "title": "project.pdf",
                "uri": "file:///project.pdf",
                "cloudKey": "attachments/project.pdf",
                "localStatus": "available",
                "createdAt": "2026-06-01T08:00:00.000Z",
                "updatedAt": "2026-06-01T08:00:00.000Z"
            }],
            "dueDate": "2026-06-10T12:00:00.000Z",
            "reviewAt": "2026-06-11T09:00:00.000Z",
            "areaId": "area-1",
            "areaTitle": "Work",
            "rev": 43,
            "revBy": "device-b",
            "createdAt": "2026-06-01T08:00:00.000Z",
            "updatedAt": "2026-06-07T08:00:00.000Z",
            "deletedAt": "2026-06-08T08:00:00.000Z",
            "purgedAt": "2026-06-09T08:00:00.000Z"
        });
        // Both the task and the project above point at area-1/section-1: with
        // the tasks/projects/sections FK columns now mirroring core's schema,
        // those rows must actually exist or the FK-enforced insert fails.
        let source = serde_json::json!({
            "tasks": [task.clone()],
            "projects": [project.clone()],
            "areas": [{
                "id": "area-1",
                "name": "Work",
                "order": 1,
                "createdAt": "2026-06-01T00:00:00.000Z",
                "updatedAt": "2026-06-01T00:00:00.000Z"
            }],
            "sections": [{
                "id": "section-1",
                "projectId": "project-full",
                "title": "Section one",
                "order": 1,
                "createdAt": "2026-06-01T00:00:00.000Z",
                "updatedAt": "2026-06-01T00:00:00.000Z"
            }],
            "people": [],
            "settings": {}
        });

        migrate_json_to_sqlite(&mut conn, &source).expect("should write fully populated records");
        let round_tripped = read_sqlite_data(&conn).expect("should read sqlite data");
        let round_tripped_task = round_tripped
            .get("tasks")
            .and_then(|value| value.as_array())
            .and_then(|tasks| tasks.first())
            .expect("should read task");
        let round_tripped_project = round_tripped
            .get("projects")
            .and_then(|value| value.as_array())
            .and_then(|projects| projects.first())
            .expect("should read project");

        for key in [
            "id",
            "title",
            "status",
            "priority",
            "energyLevel",
            "assignedTo",
            "taskMode",
            "startTime",
            "relativeStartOffset",
            "dueDate",
            "recurrence",
            "showFutureRecurrence",
            "pushCount",
            "tags",
            "contexts",
            "checklist",
            "description",
            "textDirection",
            "attachments",
            "location",
            "projectId",
            "sectionId",
            "viewSectionIds",
            "areaId",
            "order",
            "boardOrder",
            "focusOrder",
            "isFocusedToday",
            "timeEstimate",
            "timeSpentMinutes",
            "suppressMindwtrReminders",
            "repeatReminderMinutes",
            "reviewAt",
            "completedAt",
            "statusBeforeProjectArchive",
            "completedAtBeforeProjectArchive",
            "isFocusedTodayBeforeProjectArchive",
            "projectArchivedAt",
            "rev",
            "revBy",
            "createdAt",
            "updatedAt",
            "deletedAt",
            "purgedAt",
        ] {
            assert_eq!(
                round_tripped_task.get(key),
                task.get(key),
                "task field {key}"
            );
        }
        assert_eq!(round_tripped_task.get("orderNum"), task.get("order"));

        for key in [
            "id",
            "title",
            "status",
            "color",
            "order",
            "tagIds",
            "isSequential",
            "sequentialScope",
            "taskSortBy",
            "isFocused",
            "supportNotes",
            "attachments",
            "dueDate",
            "reviewAt",
            "areaId",
            "areaTitle",
            "rev",
            "revBy",
            "createdAt",
            "updatedAt",
            "deletedAt",
            "purgedAt",
        ] {
            assert_eq!(
                round_tripped_project.get(key),
                project.get(key),
                "project field {key}"
            );
        }
    }

    #[test]
    fn ensure_tasks_fts_schema_recreates_index_missing_assigned_to() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        conn.execute_batch(
            r#"
            DROP TRIGGER tasks_ai;
            DROP TRIGGER tasks_ad;
            DROP TRIGGER tasks_au;
            DROP TABLE tasks_fts;
            CREATE VIRTUAL TABLE tasks_fts USING fts5(
              id UNINDEXED,
              title,
              description,
              tags,
              contexts,
              checklist,
              location,
              content=''
            );
            "#,
        )
        .expect("should create legacy fts table");

        ensure_fts_ready(&mut conn).expect("should recreate tasks FTS table");

        let mut stmt = conn
            .prepare("PRAGMA table_info(tasks_fts)")
            .expect("should inspect fts columns");
        let column_names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("should read fts columns")
            .map(|row| row.expect("column row"))
            .collect();

        assert!(column_names.iter().any(|name| name == "checklist"));
        assert!(column_names.iter().any(|name| name == "location"));
        assert!(column_names.iter().any(|name| name == "assignedTo"));
    }

    #[test]
    fn warm_sqlite_open_defers_fts_drift_repair_until_search() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("warm-open.sqlite");
        let conn = open_sqlite_path(&db_path).expect("initialize database");
        conn.execute(
            "INSERT INTO tasks (id, title, status, createdAt, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                "task-search-repair",
                "Needle phrase",
                "next",
                "2026-08-09T00:00:00.000Z",
                "2026-08-09T00:00:00.000Z"
            ],
        )
        .expect("insert searchable task");
        conn.execute("INSERT INTO tasks_fts(tasks_fts) VALUES('delete-all')", [])
            .expect("remove FTS content without changing schema generation");
        drop(conn);

        let mut reopened = open_sqlite_path(&db_path).expect("warm reopen");
        let before_search: i64 = reopened
            .query_row("SELECT COUNT(*) FROM tasks_fts", [], |row| row.get(0))
            .expect("inspect unrepaired FTS index");
        assert_eq!(
            before_search, 0,
            "warm open must not scan and repair FTS content"
        );

        let result = search_fts_with_connection(&mut reopened, "needle")
            .expect("search should repair FTS content first");
        assert_eq!(result["tasks"][0]["id"], "task-search-repair");
    }

    #[test]
    fn sqlite_open_reinitializes_after_schema_generation_changes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("schema-generation.sqlite");
        let conn = open_sqlite_path(&db_path).expect("initialize database");
        conn.execute("DROP TRIGGER tasks_ai", [])
            .expect("simulate external DDL");
        let changed_generation = sqlite_schema_generation(&conn).expect("changed generation");
        drop(conn);

        let reopened = open_sqlite_path(&db_path).expect("reinitialize changed schema");
        let trigger_count: i64 = reopened
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'tasks_ai'",
                [],
                |row| row.get(0),
            )
            .expect("inspect repaired trigger");
        let repaired_generation = sqlite_schema_generation(&reopened).expect("repaired generation");
        let stored_state = stored_sqlite_schema_state(&reopened)
            .expect("read schema state")
            .expect("schema state row");

        assert_eq!(trigger_count, 1);
        assert!(repaired_generation > changed_generation);
        assert_eq!(stored_state.schema_generation, repaired_generation);
        assert_eq!(stored_state.storage_version, STORAGE_SCHEMA_VERSION);
    }

    #[test]
    fn sqlite_open_reinitializes_after_same_generation_file_replacement() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("same-generation-replacement.sqlite");
        let initialized = open_sqlite_path(&db_path).expect("initialize database");
        let cached_generation =
            sqlite_schema_generation(&initialized).expect("cached schema generation");
        drop(initialized);
        let warmed = open_sqlite_path(&db_path).expect("warm the process cache with file identity");
        assert_eq!(
            sqlite_schema_generation(&warmed).expect("warmed schema generation"),
            cached_generation,
        );
        drop(warmed);

        let replacement_path = temp.path().join("replacement.sqlite");
        let replacement = Connection::open(&replacement_path).expect("replacement database");
        replacement
            .pragma_update(None, "schema_version", cached_generation)
            .expect("match the cached schema generation");
        assert_eq!(
            sqlite_schema_generation(&replacement).expect("replacement schema generation"),
            cached_generation,
        );
        drop(replacement);

        fs::remove_file(&db_path).expect("remove the initialized database");
        fs::rename(&replacement_path, &db_path).expect("replace the database at the same path");

        let reopened = open_sqlite_path(&db_path).expect("initialize the replacement database");
        assert!(sqlite_table_exists(&reopened, "tasks").expect("inspect replacement schema"));
        let stored_state = stored_sqlite_schema_state(&reopened)
            .expect("read replacement schema state")
            .expect("replacement schema state row");
        assert_eq!(stored_state.storage_version, STORAGE_SCHEMA_VERSION);
        assert_eq!(
            stored_state.schema_generation,
            sqlite_schema_generation(&reopened).expect("reinitialized schema generation"),
        );
    }

    #[test]
    fn sqlite_open_reinitializes_after_same_generation_in_place_overwrite() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("same-generation-overwrite.sqlite");
        let initialized = open_sqlite_path(&db_path).expect("initialize database");
        let cached_generation =
            sqlite_schema_generation(&initialized).expect("cached schema generation");
        drop(initialized);
        drop(open_sqlite_path(&db_path).expect("warm the process cache"));

        let replacement_path = temp.path().join("overwrite-source.sqlite");
        let replacement = Connection::open(&replacement_path).expect("replacement database");
        replacement
            .pragma_update(None, "schema_version", cached_generation)
            .expect("match the cached schema generation");
        drop(replacement);
        let replacement_bytes = fs::read(&replacement_path).expect("read replacement database");

        let mut destination = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&db_path)
            .expect("open existing database object for overwrite");
        destination
            .write_all(&replacement_bytes)
            .expect("overwrite database contents in place");
        destination.sync_all().expect("sync replacement contents");
        drop(destination);

        let reopened = open_sqlite_path(&db_path).expect("initialize overwritten database");
        assert!(sqlite_table_exists(&reopened, "tasks").expect("inspect overwritten schema"));
        let stored_state = stored_sqlite_schema_state(&reopened)
            .expect("read overwritten schema state")
            .expect("overwritten schema state row");
        assert_eq!(stored_state.storage_version, STORAGE_SCHEMA_VERSION);
        assert_eq!(
            stored_state.schema_generation,
            sqlite_schema_generation(&reopened).expect("reinitialized schema generation"),
        );
    }

    #[test]
    fn failed_sqlite_initialization_is_retried() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("retry-initialization.sqlite");
        let conn = Connection::open(&db_path).expect("legacy connection");
        conn.execute_batch(SQLITE_SCHEMA).expect("legacy schema");
        conn.execute_batch(
            r#"
            DROP TRIGGER tasks_ai;
            DROP TRIGGER tasks_ad;
            DROP TRIGGER tasks_au;
            INSERT INTO tasks (id, title, status, checklist, createdAt, updatedAt)
            VALUES ('task-malformed-checklist', 'Repair me', 'next', '{malformed',
                    '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z');
            INSERT INTO tasks_fts (rowid, title, description, tags, contexts, checklist, location, assignedTo)
            SELECT rowid, title, '', '', '', '', '', '' FROM tasks;
            "#,
        )
        .expect("prepare failing migration");
        drop(conn);

        let error = open_sqlite_path(&db_path).expect_err("malformed FTS rebuild should fail");
        assert!(
            error.contains("malformed JSON"),
            "unexpected error: {error}"
        );

        let conn = Connection::open(&db_path).expect("repair connection");
        conn.execute(
            "UPDATE tasks SET checklist = '[]' WHERE id = 'task-malformed-checklist'",
            [],
        )
        .expect("repair malformed checklist");
        drop(conn);

        let reopened = open_sqlite_path(&db_path).expect("retry initialization");
        let state = stored_sqlite_schema_state(&reopened)
            .expect("read state")
            .expect("current state");
        assert_eq!(state.storage_version, STORAGE_SCHEMA_VERSION);
    }

    #[test]
    fn concurrent_first_sqlite_opens_share_one_current_schema() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = Arc::new(temp.path().join("concurrent-open.sqlite"));
        let start = Arc::new(Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let db_path = Arc::clone(&db_path);
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    open_sqlite_path(db_path.as_ref()).map(drop)
                })
            })
            .collect::<Vec<_>>();
        start.wait();

        for handle in handles {
            handle
                .join()
                .expect("initialization thread")
                .expect("concurrent open");
        }

        let conn = open_sqlite_path(db_path.as_ref()).expect("inspect initialized database");
        let state_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM storage_schema_state", [], |row| {
                row.get(0)
            })
            .expect("count schema state rows");
        assert_eq!(state_count, 1);
    }

    #[test]
    fn every_sqlite_connection_keeps_connection_local_pragmas() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("connection-pragmas.sqlite");

        for _ in 0..2 {
            let conn = open_sqlite_path(&db_path).expect("open configured connection");
            let foreign_keys: i64 = conn
                .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .expect("foreign key setting");
            let busy_timeout: i64 = conn
                .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
                .expect("busy timeout setting");
            let temp_store: i64 = conn
                .query_row("PRAGMA temp_store", [], |row| row.get(0))
                .expect("temp store setting");
            assert_eq!(foreign_keys, 1);
            assert_eq!(busy_timeout, SQLITE_BUSY_TIMEOUT_MS as i64);
            assert_eq!(temp_store, 2);
        }
    }

    #[test]
    fn sqlite_fts_indexes_checklist_titles() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");

        let data = serde_json::json!({
            "tasks": [{
                "id": "task-checklist",
                "title": "Travel prep",
                "status": "next",
                "tags": [],
                "contexts": [],
                "checklist": [
                    { "id": "item-1", "title": "Book shuttle", "isCompleted": false },
                    { "id": "item-2", "title": "Print ticket", "isCompleted": false }
                ],
                "createdAt": "2026-05-25T00:00:00.000Z",
                "updatedAt": "2026-05-25T00:00:00.000Z"
            }],
            "projects": [],
            "areas": [],
            "sections": [],
            "settings": {}
        });

        migrate_json_to_sqlite(&mut conn, &data).expect("should write data");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks_fts WHERE tasks_fts MATCH ?1",
                params!["shuttle*"],
                |row| row.get(0),
            )
            .expect("should search fts");

        assert_eq!(count, 1);
    }

    #[test]
    fn sqlite_fts_tracks_assignee_insert_update_and_delete() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");

        let data = serde_json::json!({
            "tasks": [{
                "id": "task-assignee",
                "title": "Prepare handoff",
                "status": "next",
                "assignedTo": "Alice Example",
                "tags": [],
                "contexts": [],
                "checklist": [],
                "createdAt": "2026-08-09T00:00:00.000Z",
                "updatedAt": "2026-08-09T00:00:00.000Z"
            }],
            "projects": [],
            "areas": [],
            "sections": [],
            "settings": {}
        });

        migrate_json_to_sqlite(&mut conn, &data).expect("should write data");

        let search_count = |query: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM tasks_fts WHERE tasks_fts MATCH ?1",
                params![query],
                |row| row.get(0),
            )
            .expect("should search fts")
        };

        assert_eq!(search_count("alice*"), 1);

        conn.execute(
            "UPDATE tasks SET assignedTo = ?1 WHERE id = ?2",
            params!["Bob Example", "task-assignee"],
        )
        .expect("should update assignee");
        assert_eq!(search_count("alice*"), 0);
        assert_eq!(search_count("bob*"), 1);

        conn.execute("DELETE FROM tasks WHERE id = ?1", params!["task-assignee"])
            .expect("should delete task");
        assert_eq!(search_count("bob*"), 0);
    }

    #[test]
    fn sqlite_fts_trigger_migration_rebuilds_stale_assignee_content_once() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        conn.execute_batch(
            r#"
            DROP TRIGGER tasks_ai;
            DROP TRIGGER tasks_ad;
            DROP TRIGGER tasks_au;
            INSERT INTO tasks (id, title, status, assignedTo, createdAt, updatedAt)
            VALUES ('task-stale-assignee', 'Prepare handoff', 'next', 'Alice Example',
                    '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z');
            INSERT INTO tasks_fts (rowid, title, description, tags, contexts, checklist, location)
            SELECT rowid, title, '', '', '', '', '' FROM tasks WHERE id = 'task-stale-assignee';
            INSERT OR IGNORE INTO schema_migrations (version) VALUES (3);
            "#,
        )
        .expect("should create stale pre-migration index content");

        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks_fts WHERE tasks_fts MATCH 'alice*'",
                [],
                |row| row.get(0),
            )
            .expect("should search stale index");
        assert_eq!(before, 0);

        assert!(ensure_fts_ready(&mut conn).expect("should migrate and rebuild FTS atomically"));

        let after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks_fts WHERE tasks_fts MATCH 'alice*'",
                [],
                |row| row.get(0),
            )
            .expect("should search rebuilt index");
        assert_eq!(after, 1);
        assert!(!ensure_fts_ready(&mut conn).expect("migration should be idempotent"));
        let after_restart: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks_fts WHERE tasks_fts MATCH 'alice*'",
                [],
                |row| row.get(0),
            )
            .expect("should preserve rebuilt terms on restart");
        assert_eq!(after_restart, 1);
    }

    #[test]
    fn sqlite_fts_migration_failure_rolls_back_for_other_connections() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("fts-rollback.sqlite");
        let mut writer = Connection::open(&db_path).expect("writer connection");
        writer
            .execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        writer
            .execute_batch(
                r#"
                DROP TRIGGER tasks_ai;
                DROP TRIGGER tasks_ad;
                DROP TRIGGER tasks_au;
                DELETE FROM schema_migrations WHERE version = 4;
                INSERT INTO tasks (id, title, status, checklist, createdAt, updatedAt)
                VALUES ('task-malformed-checklist', 'Stable searchable term', 'next', '{malformed',
                        '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z');
                INSERT INTO tasks_fts (rowid, title, description, tags, contexts, checklist, location, assignedTo)
                SELECT rowid, title, '', '', '', '', '', '' FROM tasks;
                "#,
            )
            .expect("should prepare stale FTS state");
        let reader = Connection::open(&db_path).expect("reader connection");

        let error =
            ensure_fts_ready(&mut writer).expect_err("malformed checklist should fail rebuild");
        assert!(
            error.contains("malformed JSON"),
            "unexpected error: {error}"
        );

        let visible_terms: i64 = reader
            .query_row(
                "SELECT COUNT(*) FROM tasks_fts WHERE tasks_fts MATCH 'stable*'",
                [],
                |row| row.get(0),
            )
            .expect("reader should retain pre-migration index");
        let visible_task_triggers: i64 = reader
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'tasks_a%'",
                [],
                |row| row.get(0),
            )
            .expect("reader should inspect rolled-back triggers");
        let visible_marker: i64 = reader
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 4",
                [],
                |row| row.get(0),
            )
            .expect("reader should inspect rolled-back migration marker");

        assert_eq!(visible_terms, 1);
        assert_eq!(visible_task_triggers, 0);
        assert_eq!(visible_marker, 0);
    }

    #[test]
    fn sqlite_project_round_trip_preserves_sequential_scope_and_task_sort() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        ensure_column(&conn, "projects", "taskSortBy", "TEXT")
            .expect("should add project task sort");

        let data = serde_json::json!({
            "tasks": [],
            "projects": [{
                "id": "project-1",
                "title": "Project",
                "status": "active",
                "color": "#6B7280",
                "order": 1,
                "tagIds": [],
                "isSequential": true,
                "sequentialScope": "section",
                "taskSortBy": "created-desc",
                "createdAt": "2026-05-25T00:00:00.000Z",
                "updatedAt": "2026-05-25T00:00:00.000Z"
            }],
            "areas": [],
            "sections": [],
            "settings": {}
        });

        migrate_json_to_sqlite(&mut conn, &data).expect("should write data");
        let read = read_sqlite_data(&conn).expect("should read data");
        let project = read["projects"]
            .as_array()
            .and_then(|projects| projects.first())
            .expect("project should exist");

        assert_eq!(project["sequentialScope"], "section");
        assert_eq!(project["taskSortBy"], "created-desc");
    }

    #[test]
    fn sqlite_people_round_trip_preserves_people() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");

        let data = serde_json::json!({
            "tasks": [],
            "projects": [],
            "areas": [],
            "sections": [],
            "people": [{
                "id": "person-1",
                "name": "Ada Lovelace",
                "note": "review owner",
                "referenceLink": "https://example.com/ada",
                "rev": 7,
                "revBy": "device-1",
                "createdAt": "2026-05-25T00:00:00.000Z",
                "updatedAt": "2026-05-26T00:00:00.000Z"
            }],
            "settings": {}
        });

        migrate_json_to_sqlite(&mut conn, &data).expect("should write data");
        let read = read_sqlite_data(&conn).expect("should read data");
        let person = read["people"]
            .as_array()
            .and_then(|people| people.first())
            .expect("person should exist");

        assert_eq!(person["id"], "person-1");
        assert_eq!(person["name"], "Ada Lovelace");
        assert_eq!(person["note"], "review owner");
        assert_eq!(person["referenceLink"], "https://example.com/ada");
        assert_eq!(person["rev"], 7);
        assert_eq!(person["revBy"], "device-1");
        assert_eq!(person["createdAt"], "2026-05-25T00:00:00.000Z");
        assert_eq!(person["updatedAt"], "2026-05-26T00:00:00.000Z");
    }

    #[test]
    fn stale_snapshot_preserves_newer_and_missing_sqlite_tasks() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");

        let current = serde_json::json!({
            "tasks": [
                {
                    "id": "task-shared",
                    "title": "Newer API edit",
                    "status": "next",
                    "tags": [],
                    "contexts": [],
                    "rev": 5,
                    "revBy": "desktop-local-api",
                    "createdAt": "2026-07-31T10:00:00Z",
                    "updatedAt": "2026-07-31T12:00:00Z"
                },
                {
                    "id": "task-api-only",
                    "title": "Created after UI snapshot",
                    "status": "inbox",
                    "tags": [],
                    "contexts": [],
                    "rev": 1,
                    "revBy": "desktop-local-api",
                    "createdAt": "2026-07-31T12:01:00Z",
                    "updatedAt": "2026-07-31T12:01:00Z"
                }
            ],
            "projects": [],
            "areas": [],
            "sections": [],
            "people": [],
            "settings": { "deviceId": "device-a" }
        });
        migrate_json_to_sqlite(&mut conn, &current).expect("should seed current sqlite data");

        let stale_ui_snapshot = serde_json::json!({
            "tasks": [{
                "id": "task-shared",
                "title": "Stale UI edit",
                "status": "next",
                "tags": [],
                "contexts": [],
                "rev": 4,
                "revBy": "desktop-ui",
                "createdAt": "2026-07-31T10:00:00Z",
                "updatedAt": "2026-07-31T11:00:00Z"
            }],
            "projects": [],
            "areas": [],
            "sections": [],
            "people": [],
            "settings": { "deviceId": "device-a" }
        });
        migrate_json_to_sqlite(&mut conn, &stale_ui_snapshot)
            .expect("stale snapshot should merge safely");

        let persisted = read_sqlite_data(&conn).expect("should read merged sqlite data");
        let tasks = persisted["tasks"].as_array().expect("tasks");
        assert_eq!(
            tasks.len(),
            2,
            "absence is not deletion; deletions use tombstones"
        );
        let shared = tasks
            .iter()
            .find(|task| task["id"] == "task-shared")
            .expect("shared task");
        assert_eq!(shared["title"], "Newer API edit");
        assert_eq!(shared["rev"], 5);
        assert!(tasks.iter().any(|task| task["id"] == "task-api-only"));

        let deletion = serde_json::json!({
            "tasks": [{
                "id": "task-shared",
                "title": "Newer API edit",
                "status": "next",
                "tags": [],
                "contexts": [],
                "rev": 6,
                "revBy": "desktop-ui",
                "createdAt": "2026-07-31T10:00:00Z",
                "updatedAt": "2026-07-31T13:00:00Z",
                "deletedAt": "2026-07-31T13:00:00Z"
            }],
            "projects": [], "areas": [], "sections": [], "people": [],
            "settings": { "deviceId": "device-a" }
        });
        migrate_json_to_sqlite(&mut conn, &deletion).expect("revisioned tombstone should merge");
        let persisted = read_sqlite_data(&conn).expect("should read tombstone");
        let shared = persisted["tasks"]
            .as_array()
            .and_then(|tasks| tasks.iter().find(|task| task["id"] == "task-shared"))
            .expect("shared task tombstone");
        assert_eq!(shared["rev"], 6);
        assert_eq!(shared["deletedAt"], "2026-07-31T13:00:00Z");
    }

    #[test]
    fn locked_mutation_reloads_reapplies_and_rolls_back_errors() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let current = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "Concurrent writer", "status": "next",
                "tags": [], "contexts": [], "rev": 5, "revBy": "mcp",
                "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
            }],
            "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
        });
        migrate_json_to_sqlite(&mut conn, &current).expect("seed current data");

        let mut patch = |data: &mut Value| {
            let task = data["tasks"][0].as_object_mut().expect("task object");
            assert_eq!(task.get("rev"), Some(&Value::Number(5.into())));
            task.insert(
                "title".to_string(),
                Value::String("Reapplied patch".to_string()),
            );
            task.insert("rev".to_string(), Value::Number(6.into()));
            Ok(())
        };
        let (_, canonical) =
            mutate_data_in_transaction(&conn, &mut patch).expect("locked mutation should persist");
        assert_eq!(canonical["tasks"][0]["title"], "Reapplied patch");
        assert_eq!(canonical["tasks"][0]["rev"], 6);

        let mut fail = |data: &mut Value| -> Result<(), String> {
            data["tasks"][0]["title"] = Value::String("Must roll back".to_string());
            Err("validation failed".to_string())
        };
        assert!(mutate_data_in_transaction(&conn, &mut fail).is_err());
        assert_eq!(
            read_sqlite_data(&conn).expect("rolled-back data")["tasks"][0]["title"],
            "Reapplied patch"
        );
    }

    #[test]
    fn read_transaction_prevents_cross_table_torn_snapshot() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("data.db");
        let reader = Connection::open(&db_path).expect("open reader");
        reader.execute_batch(SQLITE_SCHEMA).expect("create schema");
        let mut writer = Connection::open(&db_path).expect("open writer");
        writer
            .execute_batch(SQLITE_SCHEMA)
            .expect("configure writer");
        let committed = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "Committed together", "status": "next",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T10:00:00Z"
            }],
            "projects": [{
                "id": "project-1", "title": "Committed together", "status": "active",
                "color": "#2563EB", "order": 0, "tagIds": [],
                "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T10:00:00Z"
            }],
            "areas": [], "sections": [], "people": [], "settings": {}
        });

        let observed = with_sqlite_read_transaction(&reader, false, |conn| {
            let tasks_before: i64 = conn
                .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            migrate_json_to_sqlite(&mut writer, &committed)?;
            let projects_after_commit: i64 = conn
                .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            Ok((tasks_before, projects_after_commit))
        })
        .expect("read one SQLite snapshot");

        assert_eq!(observed, (0, 0));
        let latest = read_sqlite_snapshot(&reader).expect("read post-commit snapshot");
        assert_eq!(latest["tasks"].as_array().map(Vec::len), Some(1));
        assert_eq!(latest["projects"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn equal_revision_snapshot_uses_update_metadata_not_arrival_order() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let snapshot = |title: &str, updated_at: &str, rev_by: &str| {
            serde_json::json!({
                "tasks": [{
                    "id": "task-1",
                    "title": title,
                    "status": "next",
                    "tags": [],
                    "contexts": [],
                    "rev": 3,
                    "revBy": rev_by,
                    "createdAt": "2026-07-31T10:00:00Z",
                    "updatedAt": updated_at
                }],
                "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
            })
        };

        migrate_json_to_sqlite(
            &mut conn,
            &snapshot("Newer content", "2026-07-31T12:00:00Z", "writer-b"),
        )
        .expect("should seed");
        migrate_json_to_sqlite(
            &mut conn,
            &snapshot("Older content", "2026-07-31T11:00:00Z", "writer-a"),
        )
        .expect("should merge equal revision");

        let persisted = read_sqlite_data(&conn).expect("should read merged data");
        assert_eq!(persisted["tasks"][0]["title"], "Newer content");
    }

    #[test]
    fn equal_revision_compares_timestamp_instants_and_invalid_fallbacks() {
        let entity = |title: &str, updated_at: &str| {
            serde_json::json!({
                "id": "task-1", "title": title, "status": "next",
                "tags": [], "contexts": [], "rev": 3, "revBy": "writer-a",
                "createdAt": "2026-07-31T10:00:00Z", "updatedAt": updated_at
            })
        };
        let lexical_later_but_earlier_instant =
            entity("Earlier instant", "2026-07-31T10:30:00+02:00");
        let lexical_earlier_but_later_instant = entity("Later instant", "2026-07-31T09:00:00Z");

        assert!(incoming_entity_wins(
            &lexical_later_but_earlier_instant,
            &lexical_earlier_but_later_instant
        ));
        assert!(!incoming_entity_wins(
            &lexical_earlier_but_later_instant,
            &lexical_later_but_earlier_instant
        ));

        let invalid = entity("Invalid timestamp", "not-a-date");
        assert!(incoming_entity_wins(
            &invalid,
            &lexical_earlier_but_later_instant
        ));
        assert!(!incoming_entity_wins(
            &lexical_earlier_but_later_instant,
            &invalid
        ));
    }

    #[test]
    fn equal_revision_treats_iso_date_updated_at_as_utc_midnight() {
        let current = serde_json::json!({
            "id": "task-1", "title": "Current", "status": "next",
            "tags": [], "contexts": [], "rev": 3, "revBy": "writer-a",
            "createdAt": "2026-07-30T10:00:00Z", "updatedAt": "2026-07-31"
        });
        let incoming = serde_json::json!({
            "id": "task-1", "title": "Incoming", "status": "next",
            "tags": [], "contexts": [], "rev": 3, "revBy": "writer-a",
            "createdAt": "2026-07-30T10:00:00Z", "updatedAt": "2026-07-30T23:00:00Z"
        });

        assert!(!incoming_entity_wins(&current, &incoming));
        assert!(incoming_entity_wins(&incoming, &current));
    }

    #[test]
    fn missing_rev_by_uses_deterministic_content_tie_break() {
        let legacy = serde_json::json!({
            "id": "task-1", "title": "Zulu", "status": "next",
            "tags": [], "contexts": [], "rev": 3,
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
        });
        let revisioned = serde_json::json!({
            "id": "task-1", "title": "Alpha", "status": "next",
            "tags": [], "contexts": [], "rev": 3, "revBy": "writer-z",
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
        });
        assert!(entity_tie_break_json(&legacy, false) > entity_tie_break_json(&revisioned, false));
        assert!(!incoming_entity_wins(&legacy, &revisioned));
        assert!(incoming_entity_wins(&revisioned, &legacy));
    }

    #[test]
    fn equal_metadata_snapshot_tie_break_is_arrival_order_independent() {
        let snapshot = |title: &str| {
            serde_json::json!({
                "tasks": [{
                    "id": "task-1",
                    "title": title,
                    "status": "next",
                    "tags": [],
                    "contexts": [],
                    "rev": 3,
                    "revBy": "same-writer",
                    "createdAt": "2026-07-31T10:00:00Z",
                    "updatedAt": "2026-07-31T12:00:00Z"
                }],
                "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
            })
        };
        let mut left = Connection::open_in_memory().expect("left db");
        let mut right = Connection::open_in_memory().expect("right db");
        left.execute_batch(SQLITE_SCHEMA).expect("left schema");
        right.execute_batch(SQLITE_SCHEMA).expect("right schema");

        migrate_json_to_sqlite(&mut left, &snapshot("Alpha")).expect("left first");
        migrate_json_to_sqlite(&mut left, &snapshot("Zulu")).expect("left second");
        migrate_json_to_sqlite(&mut right, &snapshot("Zulu")).expect("right first");
        migrate_json_to_sqlite(&mut right, &snapshot("Alpha")).expect("right second");

        assert_eq!(
            read_sqlite_data(&left).expect("left data")["tasks"],
            read_sqlite_data(&right).expect("right data")["tasks"]
        );
    }

    #[test]
    fn revisionless_rows_inside_clock_skew_use_deterministic_content() {
        let alpha = serde_json::json!({
            "id": "task-1", "title": "Alpha", "status": "next",
            "tags": [], "contexts": [],
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:01:00Z"
        });
        let zulu = serde_json::json!({
            "id": "task-1", "title": "Zulu", "status": "next",
            "tags": [], "contexts": [],
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
        });

        assert!(incoming_entity_wins(&alpha, &zulu));
        assert!(!incoming_entity_wins(&zulu, &alpha));
    }

    #[test]
    fn exact_deterministic_signature_tie_chooses_incoming() {
        let current = serde_json::json!({
            "id": "task-1", "title": "Same", "status": "next",
            "tags": [], "contexts": [], "rev": 3, "revBy": "writer-a",
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z",
            "statusBeforeProjectArchive": "inbox"
        });
        let incoming = serde_json::json!({
            "id": "task-1", "title": "Same", "status": "next",
            "tags": [], "contexts": [], "rev": 3, "revBy": "writer-a",
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z",
            "statusBeforeProjectArchive": "waiting"
        });

        assert_eq!(
            entity_tie_break_order(&current, &incoming),
            std::cmp::Ordering::Equal
        );
        assert!(incoming_entity_wins(&current, &incoming));
    }

    #[test]
    fn oversized_revisions_are_clamped_to_the_core_maximum() {
        let oversized = serde_json::json!({
            "id": "task-1", "title": "Same", "status": "next",
            "tags": [], "contexts": [], "rev": 9_000_000_000_i64, "revBy": "writer-a",
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
        });
        let capped = serde_json::json!({
            "id": "task-1", "title": "Same", "status": "next",
            "tags": [], "contexts": [], "rev": 2_147_483_647_i64, "revBy": "writer-a",
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
        });

        assert_eq!(entity_revision(&oversized), 2_147_483_647);
        assert_eq!(entity_revision(&serde_json::json!({ "rev": -1 })), 0);
        assert_eq!(
            entity_tie_break_order(&oversized, &capped),
            std::cmp::Ordering::Equal
        );
        assert!(incoming_entity_wins(&oversized, &capped));

        let capped_newer = serde_json::json!({
            "id": "task-1", "title": "Zulu", "status": "next",
            "tags": [], "contexts": [], "rev": 2_147_483_647_i64, "revBy": "writer-a",
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T13:00:00Z"
        });
        assert!(incoming_entity_wins(&oversized, &capped_newer));
    }

    #[test]
    fn revision_metadata_is_normalized_for_signatures_and_storage() {
        let invalid = serde_json::json!({
            "id": "task-1", "title": "Same", "status": "next",
            "tags": [], "contexts": [], "rev": -1, "revBy": "   ",
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
        });
        let absent = serde_json::json!({
            "id": "task-1", "title": "Same", "status": "next",
            "tags": [], "contexts": [],
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
        });
        assert_eq!(
            entity_tie_break_order(&invalid, &absent),
            std::cmp::Ordering::Equal
        );

        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(SQLITE_SCHEMA).expect("schema");
        let data = serde_json::json!({
            "tasks": [
                invalid,
                {
                    "id": "task-2", "title": "Capped", "status": "next",
                    "tags": [], "contexts": [], "rev": 9_000_000_000_i64,
                    "revBy": " writer-a ",
                    "createdAt": "2026-07-31T10:00:00Z",
                    "updatedAt": "2026-07-31T12:00:00Z"
                }
            ],
            "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
        });
        let persisted = replace_data_in_transaction(&conn, data).expect("normalized write");
        let tasks = persisted["tasks"].as_array().expect("tasks");
        let first = tasks
            .iter()
            .find(|task| task["id"] == "task-1")
            .expect("first");
        let second = tasks
            .iter()
            .find(|task| task["id"] == "task-2")
            .expect("second");
        assert!(!first.as_object().expect("task").contains_key("rev"));
        assert!(!first.as_object().expect("task").contains_key("revBy"));
        assert_eq!(second["rev"], 2_147_483_647_i64);
        assert_eq!(second["revBy"], "writer-a");
    }

    #[test]
    fn future_clock_poison_is_clamped_before_conflict_ordering() {
        let merge_now = OffsetDateTime::parse(
            "2026-07-31T12:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .expect("merge now")
        .unix_timestamp_nanos();
        let future_live = serde_json::json!({
            "id": "task-1", "title": "Alpha", "status": "next",
            "tags": [], "contexts": [], "rev": 3, "revBy": "writer-a",
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2099-01-01T00:00:00Z"
        });
        let current_live = serde_json::json!({
            "id": "task-1", "title": "Zulu", "status": "next",
            "tags": [], "contexts": [], "rev": 3, "revBy": "writer-a",
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
        });
        assert!(incoming_entity_wins_at(
            &future_live,
            &current_live,
            merge_now
        ));

        let future_tombstone = serde_json::json!({
            "id": "task-1", "title": "Deleted", "status": "next",
            "tags": [], "contexts": [], "rev": 3, "revBy": "writer-a",
            "createdAt": "2026-07-31T10:00:00Z",
            "updatedAt": "2099-01-01T00:00:00Z",
            "deletedAt": "2099-01-01T00:00:00Z"
        });
        assert!(incoming_entity_wins_at(
            &future_tombstone,
            &current_live,
            merge_now
        ));

        let legacy_current = serde_json::json!({
            "id": "legacy", "title": "Zulu", "status": "next",
            "tags": [], "contexts": [],
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T11:59:00Z"
        });
        let legacy_one_clamped = serde_json::json!({
            "id": "legacy", "title": "Alpha", "status": "next",
            "tags": [], "contexts": [],
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2099-01-01T00:00:00Z"
        });
        assert!(incoming_entity_wins_at(
            &legacy_current,
            &legacy_one_clamped,
            merge_now
        ));

        let legacy_both_clamped = serde_json::json!({
            "id": "legacy", "title": "Alpha", "status": "next",
            "tags": [], "contexts": [],
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2100-01-01T00:00:00Z"
        });
        assert!(incoming_entity_wins_at(
            &legacy_one_clamped,
            &legacy_both_clamped,
            merge_now
        ));
    }

    #[test]
    fn settings_absence_preserves_but_present_empty_object_resets() {
        let current = serde_json::json!({
            "tasks": [], "projects": [], "areas": [], "sections": [], "people": [],
            "settings": { "theme": "dark", "deviceId": "device-a" }
        });
        let absent = serde_json::json!({
            "tasks": [], "projects": [], "areas": [], "sections": [], "people": []
        });
        let reset = serde_json::json!({
            "tasks": [], "projects": [], "areas": [], "sections": [], "people": [],
            "settings": {}
        });

        assert_eq!(
            merge_data_snapshots(&current, &absent, None)["settings"],
            current["settings"]
        );
        assert_eq!(
            merge_data_snapshots(&current, &reset, None)["settings"],
            serde_json::json!({})
        );

        let matching_baseline = serde_json::json!({
            "settings": current["settings"].clone()
        });
        assert_eq!(
            merge_data_snapshots(&current, &reset, Some(&matching_baseline))["settings"],
            serde_json::json!({}),
            "a matching settings baseline authorizes the reset"
        );
        assert_eq!(
            merge_data_snapshots(&current, &reset, Some(&serde_json::json!({})))["settings"],
            current["settings"],
            "an entity-only baseline cannot authorize a settings write"
        );
        let stale_baseline = serde_json::json!({
            "settings": { "theme": "light", "deviceId": "device-a" }
        });
        assert_eq!(
            merge_data_snapshots(&current, &reset, Some(&stale_baseline))["settings"],
            current["settings"],
            "a concurrent canonical settings change wins the CAS"
        );
    }

    #[test]
    fn changed_entity_baseline_allows_safe_pruning_and_preserves_concurrent_rows() {
        let current = serde_json::json!({
            "tasks": [
                {
                    "id": "task-prune-attachment", "title": "Prune", "status": "next",
                    "tags": [], "contexts": [], "attachments": [
                        { "id": "attachment-old", "deletedAt": "2026-06-01T00:00:00Z" }
                    ],
                    "rev": 4, "createdAt": "2026-05-01T00:00:00Z",
                    "updatedAt": "2026-06-01T00:00:00Z"
                },
                {
                    "id": "task-expired-tombstone", "title": "Expired", "status": "next",
                    "tags": [], "contexts": [], "rev": 2,
                    "createdAt": "2026-05-01T00:00:00Z",
                    "updatedAt": "2026-06-01T00:00:00Z",
                    "deletedAt": "2026-06-01T00:00:00Z"
                },
                {
                    "id": "task-concurrent", "title": "Concurrent edit", "status": "next",
                    "tags": [], "contexts": [], "rev": 3,
                    "createdAt": "2026-05-01T00:00:00Z",
                    "updatedAt": "2026-07-31T12:00:00Z"
                },
                {
                    "id": "task-unseen", "title": "Created later", "status": "inbox",
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-07-31T12:01:00Z",
                    "updatedAt": "2026-07-31T12:01:00Z"
                }
            ],
            "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
        });
        let target = serde_json::json!({
            "tasks": [
                {
                    "id": "task-prune-attachment", "title": "Prune", "status": "next",
                    "tags": [], "contexts": [], "attachments": [], "rev": 4,
                    "createdAt": "2026-05-01T00:00:00Z",
                    "updatedAt": "2026-06-01T00:00:00Z"
                },
                {
                    "id": "task-concurrent", "title": "Stale edit", "status": "next",
                    "tags": [], "contexts": [], "rev": 2,
                    "createdAt": "2026-05-01T00:00:00Z",
                    "updatedAt": "2026-07-31T11:00:00Z"
                },
                {
                    "id": "task-new", "title": "New target", "status": "inbox",
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-07-31T13:00:00Z",
                    "updatedAt": "2026-07-31T13:00:00Z"
                }
            ],
            "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
        });
        let baseline_entities = serde_json::json!({
            "tasks": [
                current["tasks"][0].clone(),
                current["tasks"][1].clone(),
                {
                    "id": "task-concurrent", "title": "Originally observed", "status": "next",
                    "tags": [], "contexts": [], "rev": 2,
                    "createdAt": "2026-05-01T00:00:00Z",
                    "updatedAt": "2026-07-31T11:00:00Z"
                }
            ]
        });

        let merged = merge_data_snapshots(&current, &target, Some(&baseline_entities));
        let tasks = merged["tasks"].as_array().expect("tasks");
        let task = |id: &str| tasks.iter().find(|task| task["id"] == id);
        assert_eq!(
            task("task-prune-attachment").expect("pruned task")["attachments"],
            serde_json::json!([]),
            "a nested tombstone can be pruned without an entity revision bump"
        );
        assert!(task("task-expired-tombstone").is_none());
        assert_eq!(
            task("task-concurrent").expect("concurrent task")["title"],
            "Concurrent edit"
        );
        assert!(task("task-unseen").is_some());
        assert!(task("task-new").is_some());
    }

    #[test]
    fn observed_ids_prevent_resurrection_after_exact_restore_but_allow_new_rows() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let observed_task = serde_json::json!({
            "id": "task-observed", "title": "Observed", "status": "next",
            "tags": [], "contexts": [], "rev": 1,
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T10:00:00Z"
        });
        let observed = serde_json::json!({
            "tasks": [observed_task.clone()],
            "projects": [], "areas": [], "sections": [], "people": [],
            "settings": { "theme": "light" }
        });
        migrate_json_to_sqlite(&mut conn, &observed).expect("seed observed data");
        let baseline = serde_json::json!({
            "observedEntityIds": {
                "tasks": ["task-observed"],
                "projects": [], "areas": [], "sections": [], "people": []
            },
            "settings": observed["settings"].clone()
        });

        let restored = serde_json::json!({
            "tasks": [], "projects": [], "areas": [], "sections": [], "people": [],
            "settings": { "theme": "light" }
        });
        replace_json_in_sqlite(&mut conn, &restored).expect("external exact restore");
        let target = serde_json::json!({
            "tasks": [
                observed_task,
                {
                    "id": "task-new", "title": "Created locally", "status": "inbox",
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-07-31T11:00:00Z", "updatedAt": "2026-07-31T11:00:00Z"
                }
            ],
            "projects": [], "areas": [], "sections": [], "people": [],
            "settings": { "theme": "dark" }
        });

        let canonical =
            merge_json_to_sqlite(&mut conn, &target, Some(&baseline)).expect("guarded save");

        let tasks = canonical["tasks"].as_array().expect("tasks");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["id"], "task-new");
        assert_eq!(canonical["settings"]["theme"], "dark");
    }

    #[test]
    fn matching_baseline_never_authorizes_an_entity_revision_rollback() {
        let current = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "Canonical", "status": "next",
                "tags": [], "contexts": [], "rev": 5,
                "createdAt": "2026-07-31T10:00:00Z",
                "updatedAt": "2026-07-31T12:00:00Z"
            }],
            "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
        });
        let target = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "Rolled back", "status": "next",
                "tags": [], "contexts": [], "rev": 4,
                "createdAt": "2026-07-31T10:00:00Z",
                "updatedAt": "2026-07-31T13:00:00Z",
                "deletedAt": "2026-07-31T13:00:00Z"
            }],
            "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
        });
        let baseline = serde_json::json!({ "tasks": [current["tasks"][0].clone()] });

        let merged = merge_data_snapshots(&current, &target, Some(&baseline));

        assert_eq!(merged["tasks"][0]["title"], "Canonical");
        assert_eq!(merged["tasks"][0]["rev"], 5);
    }

    #[test]
    fn snapshot_materializes_and_semantically_deduplicates_canonical_sqlite() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let initial = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "Canonical SQLite", "status": "next",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-07-31T10:00:00Z",
                "updatedAt": "2026-07-31T10:00:00Z"
            }],
            "projects": [], "areas": [], "sections": [], "people": [],
            "settings": { "theme": "dark" }
        });
        migrate_json_to_sqlite(&mut conn, &initial).expect("seed canonical SQLite");
        let temp = tempfile::tempdir().expect("tempdir");
        let snapshot_dir = temp.path().join("snapshots");
        fs::write(
            temp.path().join("data.json"),
            br#"{"tasks":[{"id":"stale-json","title":"Stale JSON"}]}"#,
        )
        .expect("write stale recovery copy");
        let first_time = OffsetDateTime::from_unix_timestamp(1_700_000_000).expect("timestamp");

        let first_name = create_data_snapshot_from_connection(&conn, &snapshot_dir, first_time)
            .expect("create canonical snapshot");
        let first_path = snapshot_dir.join(&first_name);
        let first_snapshot = read_json_with_retries(&first_path, 1).expect("read snapshot");
        assert_eq!(first_snapshot["tasks"][0]["title"], "Canonical SQLite");
        assert!(first_snapshot["tasks"]
            .as_array()
            .expect("tasks")
            .iter()
            .all(|task| task["id"] != "stale-json"));

        // Byte formatting is not identity: a semantically equal latest
        // snapshot must still deduplicate against canonical SQLite.
        fs::write(
            &first_path,
            serde_json::to_vec(&first_snapshot).expect("serialize compact snapshot"),
        )
        .expect("rewrite snapshot with different formatting");
        let deduped_name = create_data_snapshot_from_connection(
            &conn,
            &snapshot_dir,
            first_time + time::Duration::seconds(1),
        )
        .expect("deduplicate snapshot");
        assert_eq!(deduped_name, first_name);
        assert_eq!(list_snapshot_entries(&snapshot_dir).len(), 1);

        let changed = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "New canonical", "status": "next",
                "tags": [], "contexts": [], "rev": 2,
                "createdAt": "2026-07-31T10:00:00Z",
                "updatedAt": "2026-07-31T11:00:00Z"
            }],
            "projects": [], "areas": [], "sections": [], "people": [],
            "settings": { "theme": "dark" }
        });
        migrate_json_to_sqlite(&mut conn, &changed).expect("update canonical SQLite");
        let second_name = create_data_snapshot_from_connection(&conn, &snapshot_dir, first_time)
            .expect("create changed snapshot at the same instant");
        assert_ne!(second_name, first_name);
        assert_eq!(list_snapshot_entries(&snapshot_dir).len(), 2);
        assert_eq!(
            read_json_with_retries(&snapshot_dir.join(second_name), 1)
                .expect("read collision-safe snapshot")["tasks"][0]["title"],
            "New canonical"
        );
    }

    #[test]
    fn snapshot_temp_files_are_never_listed_as_recovery_points() {
        let temp = tempfile::tempdir().expect("tempdir");
        let snapshot_dir = temp.path().join("snapshots");
        fs::create_dir(&snapshot_dir).expect("snapshot dir");
        let partial = snapshot_dir.join(".mindwtr-snapshot-partial.tmp");
        fs::write(&partial, b"{\"tasks\":[").expect("partial temp");

        assert!(list_snapshot_entries(&snapshot_dir).is_empty());

        let canonical = serde_json::json!({
            "tasks": [], "projects": [], "areas": [], "sections": [], "people": [],
            "settings": { "theme": "dark" }
        });
        let now = OffsetDateTime::from_unix_timestamp(1_700_000_000).expect("timestamp");
        let file_name =
            write_new_data_snapshot(&snapshot_dir, &canonical, now).expect("atomic snapshot");
        let entries = list_snapshot_entries(&snapshot_dir);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, file_name);
        assert_eq!(
            read_json_with_retries(&snapshot_dir.join(file_name), 1).expect("complete snapshot"),
            canonical
        );
    }

    #[test]
    fn concurrent_data_json_publications_never_share_a_temp_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_path = std::sync::Arc::new(temp.path().join("data.json"));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let mut writers = Vec::new();
        for writer in 0..8 {
            let data_path = std::sync::Arc::clone(&data_path);
            let barrier = std::sync::Arc::clone(&barrier);
            writers.push(std::thread::spawn(move || {
                barrier.wait();
                for sequence in 0..10 {
                    write_data_json_file(
                        &data_path,
                        &serde_json::json!({
                            "writer": writer,
                            "sequence": sequence,
                            "payload": "x".repeat(4_096)
                        }),
                    )?;
                }
                Ok::<(), String>(())
            }));
        }
        for writer in writers {
            writer.join().expect("writer thread").expect("publication");
        }

        let final_value = read_json_with_retries(&data_path, 1).expect("valid final recovery copy");
        assert!(final_value.get("writer").and_then(Value::as_i64).is_some());
        assert!(final_value
            .get("sequence")
            .and_then(Value::as_i64)
            .is_some());
        assert!(!data_json_backup_path(&data_path).exists());
        assert!(fs::read_dir(temp.path())
            .expect("data directory")
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".mindwtr-data-")));
    }

    #[test]
    fn failed_backup_replacement_restores_the_original_data_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_path = temp.path().join("data.json");
        let backup_path = data_json_backup_path(&data_path);
        let replacement_path = temp.path().join("replacement.tmp");
        fs::write(&data_path, b"original").expect("original data");
        fs::write(&replacement_path, b"replacement").expect("replacement data");
        let mut rename_call = 0;

        let error = replace_data_json_with_backup(
            &replacement_path,
            &data_path,
            &backup_path,
            |from, to| {
                rename_call += 1;
                if rename_call == 2 {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "injected replacement failure",
                    ));
                }
                fs::rename(from, to)
            },
            |path| fs::remove_file(path),
        )
        .expect_err("replacement must fail");

        assert!(error.contains("injected replacement failure"));
        assert_eq!(
            fs::read(&data_path).expect("restored original"),
            b"original"
        );
        assert!(!backup_path.exists());
        assert_eq!(
            fs::read(&replacement_path).expect("unpublished replacement"),
            b"replacement"
        );
    }

    #[test]
    fn failed_backup_replacement_and_restore_leave_a_recoverable_backup() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_path = temp.path().join("data.json");
        let backup_path = data_json_backup_path(&data_path);
        let replacement_path = temp.path().join("replacement.tmp");
        fs::write(&data_path, b"original").expect("original data");
        fs::write(&replacement_path, b"replacement").expect("replacement data");
        let mut rename_call = 0;

        let error = replace_data_json_with_backup(
            &replacement_path,
            &data_path,
            &backup_path,
            |from, to| {
                rename_call += 1;
                match rename_call {
                    2 => Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "injected replacement failure",
                    )),
                    3 => Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "injected restore failure",
                    )),
                    _ => fs::rename(from, to),
                }
            },
            |path| fs::remove_file(path),
        )
        .expect_err("replacement and immediate restore must fail");

        assert!(error.contains("injected replacement failure"));
        assert!(error.contains("injected restore failure"));
        assert!(
            error.contains(&backup_path.display().to_string()),
            "the diagnostic must identify the recovery copy"
        );
        assert!(
            !data_path.exists(),
            "the failed restore leaves no partial final file"
        );
        assert_eq!(
            fs::read(&backup_path).expect("recoverable original"),
            b"original"
        );
        assert_eq!(
            fs::read(&replacement_path).expect("unpublished replacement"),
            b"replacement"
        );

        cleanup_stale_data_json_backup_for_platform(&data_path, true)
            .expect("the next startup restores the recovery copy");
        assert_eq!(
            fs::read(&data_path).expect("restored original"),
            b"original"
        );
        assert!(!backup_path.exists());
    }

    #[test]
    fn stale_backup_cleanup_restores_or_discards_transactionally() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_path = temp.path().join("data.json");
        let backup_path = data_json_backup_path(&data_path);
        fs::write(&backup_path, b"recoverable").expect("backup");

        cleanup_stale_data_json_backup_for_platform(&data_path, true)
            .expect("restore missing data");
        assert_eq!(fs::read(&data_path).expect("restored data"), b"recoverable");
        assert!(!backup_path.exists());

        fs::write(&backup_path, b"stale").expect("stale backup");
        cleanup_stale_data_json_backup_for_platform(&data_path, true)
            .expect("discard stale backup");
        assert_eq!(
            fs::read(&data_path).expect("canonical data"),
            b"recoverable"
        );
        assert!(!backup_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_data_json_replacement_uses_backup_and_cleans_it() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_path = temp.path().join("data.json");
        fs::write(&data_path, b"{\"version\":1}").expect("original");

        write_data_json_file(&data_path, &serde_json::json!({ "version": 2 }))
            .expect("Windows replacement");

        assert_eq!(
            read_json_with_retries(&data_path, 1).expect("new data")["version"],
            2
        );
        assert!(!data_json_backup_path(&data_path).exists());
    }

    #[test]
    fn exact_replace_removes_rows_even_when_target_is_empty() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let current = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "Existing", "status": "next",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T10:00:00Z"
            }],
            "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
        });
        migrate_json_to_sqlite(&mut conn, &current).expect("seed current data");
        let empty = serde_json::json!({
            "tasks": [], "projects": [], "areas": [], "sections": [], "people": [],
            "settings": {}
        });

        let canonical = replace_json_in_sqlite(&mut conn, &empty).expect("exact replacement");

        assert_eq!(canonical["tasks"], serde_json::json!([]));
        assert_eq!(
            read_sqlite_data(&conn).expect("persisted")["tasks"],
            serde_json::json!([])
        );
    }

    #[test]
    fn observed_last_tombstone_can_be_physically_pruned() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let current = serde_json::json!({
            "tasks": [{
                "id": "task-old", "title": "Expired", "status": "next",
                "tags": [], "contexts": [], "rev": 2,
                "createdAt": "2026-05-01T00:00:00Z",
                "updatedAt": "2026-06-01T00:00:00Z",
                "deletedAt": "2026-06-01T00:00:00Z"
            }],
            "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
        });
        migrate_json_to_sqlite(&mut conn, &current).expect("seed tombstone");
        let canonical = read_sqlite_data(&conn).expect("canonical baseline");
        let baseline = serde_json::json!({ "tasks": [canonical["tasks"][0].clone()] });
        let empty = serde_json::json!({
            "tasks": [], "projects": [], "areas": [], "sections": [], "people": [],
            "settings": {}
        });

        refuse_empty_snapshot_overwrite(&conn, &empty, Some(&baseline))
            .expect("CAS baseline permits intentional pruning");
        let persisted =
            merge_json_to_sqlite(&mut conn, &empty, Some(&baseline)).expect("prune last tombstone");

        assert_eq!(persisted["tasks"], serde_json::json!([]));
    }

    #[test]
    fn delete_live_resolution_matches_adr_0007_and_counts_purged_rows_as_deleted() {
        let live = |updated_at: &str, rev: Option<i64>| {
            let mut value = serde_json::json!({
                "id": "task-1", "updatedAt": updated_at
            });
            if let Some(rev) = rev {
                value["rev"] = Value::Number(rev.into());
            }
            value
        };
        let tombstone = |updated_at: &str, deleted_at: &str, rev: Option<i64>| {
            let mut value = live(updated_at, rev);
            value["deletedAt"] = Value::String(deleted_at.to_string());
            value
        };

        let delete_near = tombstone("2026-07-31T12:00:00Z", "2026-07-31T12:00:15Z", Some(3));
        let live_same_rev = live("2026-07-31T12:00:00Z", Some(3));
        assert!(incoming_entity_wins(&delete_near, &live_same_rev));
        assert!(!incoming_entity_wins(&live_same_rev, &delete_near));

        let higher_rev_delete = tombstone("2026-07-31T12:00:00Z", "2026-07-31T12:00:15Z", Some(4));
        assert!(incoming_entity_wins(&live_same_rev, &higher_rev_delete));

        let delete_later = tombstone("2026-07-31T12:00:00Z", "2026-07-31T12:00:31Z", Some(3));
        assert!(incoming_entity_wins(&live_same_rev, &delete_later));
        let live_later = live("2026-07-31T12:01:02Z", Some(3));
        assert!(incoming_entity_wins(&delete_later, &live_later));

        let legacy_live = live("2026-07-31T12:00:00Z", None);
        let legacy_delete = tombstone("2026-07-31T12:00:00Z", "2026-07-31T12:00:00Z", None);
        assert!(incoming_entity_wins(&legacy_live, &legacy_delete));
        assert!(!incoming_entity_wins(&legacy_delete, &legacy_live));

        let zero_rev_live = live("2026-07-31T12:00:00Z", Some(0));
        let zero_rev_delete = tombstone("2026-07-31T12:00:00Z", "2026-07-31T12:00:00Z", Some(0));
        assert!(incoming_entity_wins(&zero_rev_live, &zero_rev_delete));
        let mut revisioned_live = zero_rev_live.clone();
        revisioned_live["revBy"] = Value::String("device-a".to_string());
        assert!(incoming_entity_wins(&zero_rev_delete, &revisioned_live));

        let mut purged = live("2026-07-31T12:00:00Z", Some(3));
        purged["purgedAt"] = Value::String("2026-07-31T12:00:10Z".to_string());
        assert!(entity_is_deleted(&purged));
        assert!(incoming_entity_wins(&purged, &live_same_rev));
    }

    #[test]
    fn deterministic_entity_winner_compares_content_before_metadata() {
        let current = serde_json::json!({
            "id": "task-1", "title": "Alpha", "status": "next",
            "tags": [], "contexts": [], "rev": 3,
            "createdAt": "z", "updatedAt": "invalid"
        });
        let incoming = serde_json::json!({
            "id": "task-1", "title": "Zulu", "status": "next",
            "tags": [], "contexts": [], "rev": 3,
            "createdAt": "a", "updatedAt": "invalid"
        });

        assert!(incoming_entity_wins(&current, &incoming));
        assert!(!incoming_entity_wins(&incoming, &current));

        let metadata_only = serde_json::json!({
            "id": "task-1", "title": "Alpha", "status": "next",
            "tags": [], "contexts": [], "rev": 3,
            "createdAt": "zz", "updatedAt": "invalid"
        });
        assert!(incoming_entity_wins(&current, &metadata_only));
    }

    #[test]
    fn data_json_refresh_failure_does_not_change_committed_sqlite_data() {
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let data = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "Committed", "status": "next",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T10:00:00Z"
            }],
            "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
        });
        migrate_json_to_sqlite(&mut conn, &data).expect("sqlite commit");
        let temp = tempfile::tempdir().expect("tempdir");
        let unwritable_file = temp.path().join("data.json");
        fs::create_dir(&unwritable_file).expect("directory blocks file replacement");

        let canonical = read_sqlite_data(&conn).expect("canonical data");
        write_data_json_best_effort(&unwritable_file, &canonical);

        assert_eq!(
            read_sqlite_data(&conn).expect("sqlite data")["tasks"][0]["title"],
            "Committed"
        );
    }

    #[test]
    fn incremental_task_save_refreshes_data_json_from_canonical_sqlite() {
        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let temp = tempfile::tempdir().expect("tempdir");
        let data_path = temp.path().join("data.json");
        let task = serde_json::json!({
            "id": "task-1", "title": "Incremental edit", "status": "next",
            "tags": [], "contexts": [], "rev": 2,
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
        });

        let canonical =
            persist_task_snapshot(&conn, &task, &data_path, None).expect("incremental task save");
        let mirrored: Value =
            serde_json::from_slice(&fs::read(&data_path).expect("data.json should be refreshed"))
                .expect("valid data.json");

        assert_eq!(canonical["tasks"][0]["title"], "Incremental edit");
        assert_eq!(mirrored, canonical);
    }

    #[test]
    fn repeated_snapshot_version_churn_returns_the_last_consistent_read() {
        let version_reads = std::cell::Cell::new(0_i64);
        let snapshot_reads = std::cell::Cell::new(0_i64);

        let (canonical, expected_version) = stable_snapshot_with_version_readers(
            || {
                let next = version_reads.get() + 1;
                version_reads.set(next);
                Ok(next)
            },
            || {
                let next = snapshot_reads.get() + 1;
                snapshot_reads.set(next);
                Ok(serde_json::json!({ "read": next }))
            },
        )
        .expect("post-commit churn must not become a false save failure");

        assert_eq!(snapshot_reads.get(), STORAGE_RETRY_ATTEMPTS as i64);
        assert_eq!(canonical["read"], STORAGE_RETRY_ATTEMPTS as i64);
        assert_eq!(expected_version, version_reads.get() - 1);
    }

    #[test]
    fn incremental_task_save_reports_commit_when_post_commit_snapshot_read_fails() {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(SQLITE_SCHEMA).expect("schema");
        let temp = tempfile::tempdir().expect("tempdir");
        let task = serde_json::json!({
            "id": "task-1", "title": "Durably committed", "status": "next",
            "tags": [], "contexts": [], "rev": 1,
            "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
        });

        let result = persist_task_snapshot_with_reader(
            &conn,
            &task,
            &temp.path().join("data.json"),
            None,
            || Err("injected post-commit read failure".to_string()),
        )
        .expect("a committed task save must not become a false failure");

        assert!(result.committed);
        assert!(result.canonical_reload_required);
        assert!(result.canonical.is_none());
        assert_eq!(
            conn.query_row("SELECT title FROM tasks WHERE id = 'task-1'", [], |row| row
                .get::<_, String>(0),)
                .expect("committed row"),
            "Durably committed"
        );
    }

    #[test]
    fn task_snapshot_commit_releases_writer_before_data_json_publication() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("data.db");
        let first = Connection::open(&db_path).expect("open first connection");
        first.execute_batch(SQLITE_SCHEMA).expect("create schema");
        let second = Connection::open(&db_path).expect("open second connection");
        second
            .execute_batch(SQLITE_SCHEMA)
            .expect("configure second connection");
        let task = serde_json::json!({
            "id": "task-1", "title": "Incremental edit", "status": "next",
            "tags": [], "contexts": [], "rev": 1,
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T10:00:00Z"
        });

        commit_task_snapshot(&first, &task, None).expect("commit task snapshot");

        assert!(first.is_autocommit());
        second
            .execute_batch("BEGIN IMMEDIATE; ROLLBACK;")
            .expect("another writer can start before data.json publication");
        let (canonical, data_version) =
            stable_sqlite_snapshot_with_version(&first).expect("canonical snapshot after commit");
        let data_path = temp.path().join("data.json");
        let published = publish_task_data_json(&first, &data_path, canonical, data_version);
        assert_eq!(
            read_json_with_retries(&data_path, 1).expect("recovery copy"),
            published
        );
    }

    #[test]
    fn task_row_mutation_writes_only_changed_rows_and_releases_writer() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("data.db");
        let first = Connection::open(&db_path).expect("first connection");
        first.execute_batch(SQLITE_SCHEMA).expect("schema");
        let tasks = (0..1_000)
            .map(|index| {
                serde_json::json!({
                    "id": format!("task-{index}"),
                    "title": format!("Task {index}"),
                    "status": "next", "tags": [], "contexts": [],
                    "rev": 1, "revBy": "writer-a",
                    "createdAt": "2026-07-31T10:00:00Z",
                    "updatedAt": "2026-07-31T10:00:00Z"
                })
            })
            .collect::<Vec<_>>();
        replace_data_in_transaction(
            &first,
            serde_json::json!({
                "tasks": tasks,
                "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
            }),
        )
        .expect("seed large store");
        let unrelated_rowid: i64 = first
            .query_row("SELECT rowid FROM tasks WHERE id = 'task-999'", [], |row| {
                row.get(0)
            })
            .expect("unrelated rowid");
        let changes_before: i64 = first
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .expect("changes before");
        let mut mutation = |data: &mut Value| {
            let task = data["tasks"]
                .as_array_mut()
                .expect("tasks")
                .iter_mut()
                .find(|task| task["id"] == "task-0")
                .expect("target");
            task["title"] = Value::String("Edited".to_string());
            task["rev"] = Value::Number(2.into());
            task["updatedAt"] = Value::String("2026-07-31T12:00:00Z".to_string());
            Ok::<_, String>(((), vec![task.clone()]))
        };

        let scope = TaskMutationReadScope::existing("task-0", false);
        let (_, _, read_stats) =
            commit_task_row_mutation(&first, &scope, &mut mutation).expect("row-scoped commit");

        assert!(first.is_autocommit());
        assert_eq!(read_stats.statements, 2);
        assert_eq!(read_stats.rows, 2);
        assert_eq!(read_stats.task_rows, 1);
        let changes_after: i64 = first
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .expect("changes after");
        assert!(changes_after - changes_before < 50);
        assert_eq!(
            first
                .query_row("SELECT rowid FROM tasks WHERE id = 'task-999'", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("unrelated rowid after"),
            unrelated_rowid
        );
        assert_eq!(
            first
                .query_row("SELECT title FROM tasks WHERE id = 'task-999'", [], |row| {
                    row.get::<_, String>(0)
                })
                .expect("unrelated title"),
            "Task 999"
        );
        let second = Connection::open(&db_path).expect("second connection");
        second
            .execute_batch("BEGIN IMMEDIATE; ROLLBACK;")
            .expect("writer lock released before recovery publication");
    }

    #[test]
    fn focused_create_scope_reads_only_referenced_context_and_sequential_candidates() {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(SQLITE_SCHEMA).expect("schema");
        let mut tasks = (0..1_000)
            .map(|index| {
                serde_json::json!({
                    "id": format!("unrelated-{index}"),
                    "title": format!("Unrelated {index}"),
                    "status": "inbox", "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-07-31T10:00:00Z",
                    "updatedAt": "2026-07-31T10:00:00Z"
                })
            })
            .collect::<Vec<_>>();
        tasks.extend([
            serde_json::json!({
                "id": "sequential-first", "title": "First", "status": "next",
                "projectId": "project-1", "sectionId": "section-1",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-07-31T08:00:00Z", "updatedAt": "2026-07-31T08:00:00Z"
            }),
            serde_json::json!({
                "id": "other-section", "title": "Other section", "status": "next",
                "projectId": "project-1", "sectionId": "section-2",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-07-31T08:00:00Z", "updatedAt": "2026-07-31T08:00:00Z"
            }),
            serde_json::json!({
                "id": "focused-elsewhere", "title": "Focused", "status": "next",
                "isFocusedToday": true, "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-07-31T08:00:00Z", "updatedAt": "2026-07-31T08:00:00Z"
            }),
        ]);
        replace_data_in_transaction(
            &conn,
            serde_json::json!({
                "tasks": tasks,
                "projects": [{
                    "id": "project-1", "title": "Sequential", "status": "active",
                    "color": "#000000", "isSequential": true,
                    "sequentialScope": "section", "tagIds": [],
                    "createdAt": "2026-07-31T08:00:00Z", "updatedAt": "2026-07-31T08:00:00Z"
                }],
                "sections": [
                    { "id": "section-1", "projectId": "project-1", "title": "One",
                      "createdAt": "2026-07-31T08:00:00Z", "updatedAt": "2026-07-31T08:00:00Z" },
                    { "id": "section-2", "projectId": "project-1", "title": "Two",
                      "createdAt": "2026-07-31T08:00:00Z", "updatedAt": "2026-07-31T08:00:00Z" }
                ],
                "areas": [{ "id": "area-1", "name": "Area", "order": 0 }],
                "people": [],
                "settings": { "deviceId": "device-a", "gtd": { "focusTaskLimit": 3 } }
            }),
        )
        .expect("seed large store");
        let scope = TaskMutationReadScope::create(
            Some("project-1"),
            Some("section-1"),
            Some("area-1"),
            true,
        );

        let (data, stats) = read_task_mutation_data(&conn, &scope).expect("scoped context");

        assert_eq!(data["projects"].as_array().map(Vec::len), Some(1));
        assert_eq!(data["sections"].as_array().map(Vec::len), Some(1));
        assert_eq!(data["areas"].as_array().map(Vec::len), Some(1));
        assert_eq!(data[TASK_MUTATION_FOCUSED_COUNT_KEY], 1);
        assert_eq!(data["settings"]["deviceId"], "device-a");
        assert_eq!(
            data["tasks"]
                .as_array()
                .expect("scoped tasks")
                .iter()
                .map(|task| task["id"].as_str().expect("task id"))
                .collect::<Vec<_>>(),
            vec!["sequential-first"]
        );
        assert_eq!(stats.task_rows, 1);
        assert!(stats.statements <= 6);
    }

    #[test]
    fn patch_scope_reads_current_and_requested_task_containers() {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(SQLITE_SCHEMA).expect("schema");
        replace_data_in_transaction(
            &conn,
            serde_json::json!({
                "tasks": [{
                    "id": "task-1", "title": "Task", "status": "next",
                    "projectId": "project-a", "sectionId": "section-a",
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                }],
                "projects": [
                    { "id": "project-a", "title": "A", "status": "active", "color": "#000", "tagIds": [],
                      "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z" },
                    { "id": "project-b", "title": "B", "status": "active", "color": "#000", "tagIds": [],
                      "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z" }
                ],
                "sections": [
                    { "id": "section-a", "projectId": "project-a", "title": "A section",
                      "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z" },
                    { "id": "section-b", "projectId": "project-b", "title": "B section",
                      "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z" }
                ],
                "areas": [{ "id": "area-b", "name": "Area", "order": 0,
                    "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z" }],
                "people": [], "settings": { "deviceId": "desktop-local-api" }
            }),
        )
        .expect("seed store");

        let scope = TaskMutationReadScope::patch(
            "task-1",
            Some("project-b"),
            Some("section-b"),
            Some("area-b"),
        );
        let (data, stats) = read_task_mutation_data(&conn, &scope).expect("patch context");

        assert_eq!(data["tasks"].as_array().map(Vec::len), Some(1));
        assert_eq!(data["projects"].as_array().map(Vec::len), Some(2));
        assert_eq!(data["sections"].as_array().map(Vec::len), Some(2));
        assert_eq!(data["areas"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            data[TASK_MUTATION_PROJECT_NEXT_ORDERS_KEY]["project-b"].as_f64(),
            Some(0.0)
        );
        assert!(
            stats.statements <= 9,
            "patch reads remain row-scoped: {stats:?}"
        );
    }

    #[test]
    fn task_storage_uses_core_order_alias_precedence() {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(SQLITE_SCHEMA).expect("schema");
        for task in [
            serde_json::json!({
                "id": "conflicting", "title": "Conflicting", "status": "next",
                "order": 2, "orderNum": 99,
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
            }),
            serde_json::json!({
                "id": "order-only", "title": "Order only", "status": "next",
                "order": 4,
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
            }),
            serde_json::json!({
                "id": "order-num-only", "title": "OrderNum only", "status": "next",
                "orderNum": 6,
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
            }),
        ] {
            replace_task_row(&conn, &task).expect("replace task row");
        }

        let stored = ["conflicting", "order-only", "order-num-only"].map(|task_id| {
            conn.query_row(
                "SELECT orderNum FROM tasks WHERE id = ?1",
                [task_id],
                |row| row.get::<_, f64>(0),
            )
            .expect("stored order")
        });

        assert_eq!(stored, [2.0, 4.0, 6.0]);
    }

    #[test]
    fn bulk_task_storage_uses_core_order_alias_precedence() {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(SQLITE_SCHEMA).expect("schema");
        replace_data_in_transaction(
            &conn,
            serde_json::json!({
                "tasks": [
                    {
                        "id": "conflicting", "title": "Conflicting", "status": "next",
                        "order": 2, "orderNum": 99,
                        "tags": [], "contexts": [], "rev": 1,
                        "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                    },
                    {
                        "id": "order-only", "title": "Order only", "status": "next",
                        "order": 4,
                        "tags": [], "contexts": [], "rev": 1,
                        "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                    },
                    {
                        "id": "order-num-only", "title": "OrderNum only", "status": "next",
                        "orderNum": 6,
                        "tags": [], "contexts": [], "rev": 1,
                        "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                    }
                ],
                "projects": [], "sections": [], "areas": [], "people": [], "settings": {}
            }),
        )
        .expect("replace full data");

        let stored = ["conflicting", "order-only", "order-num-only"].map(|task_id| {
            conn.query_row(
                "SELECT orderNum FROM tasks WHERE id = ?1",
                [task_id],
                |row| row.get::<_, f64>(0),
            )
            .expect("stored order")
        });

        assert_eq!(stored, [2.0, 4.0, 6.0]);
    }

    #[test]
    fn concurrent_project_moves_reserve_distinct_destination_orders_in_the_write_transaction() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("data.db");
        let seed = Connection::open(&db_path).expect("seed connection");
        seed.execute_batch(SQLITE_SCHEMA).expect("schema");
        replace_data_in_transaction(
            &seed,
            serde_json::json!({
                "tasks": [
                    {
                        "id": "move-1", "title": "Move one", "status": "next",
                        "projectId": "project-a", "order": 0, "orderNum": 0,
                        "tags": [], "contexts": [], "rev": 1,
                        "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                    },
                    {
                        "id": "move-2", "title": "Move two", "status": "next",
                        "projectId": "project-a", "order": 1, "orderNum": 1,
                        "tags": [], "contexts": [], "rev": 1,
                        "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                    },
                    {
                        "id": "destination-high", "title": "Destination", "status": "next",
                        "projectId": "project-b", "sectionId": "section-b",
                        "order": 5, "orderNum": 5,
                        "tags": [], "contexts": [], "rev": 1,
                        "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                    },
                    {
                        "id": "destination-deleted", "title": "Deleted", "status": "next",
                        "projectId": "project-b", "order": 99, "orderNum": 99,
                        "deletedAt": "2026-08-02T10:00:00Z",
                        "tags": [], "contexts": [], "rev": 2,
                        "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-02T10:00:00Z"
                    }
                ],
                "projects": [
                    { "id": "project-a", "title": "A", "status": "active", "color": "#000", "tagIds": [],
                      "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z" },
                    { "id": "project-b", "title": "B", "status": "active", "color": "#000", "tagIds": [],
                      "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z" }
                ],
                "sections": [{
                    "id": "section-b", "projectId": "project-b", "title": "B section",
                    "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                }],
                "areas": [], "people": [],
                "settings": { "deviceId": "desktop-local-api" }
            }),
        )
        .expect("seed store");
        drop(seed);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let handles = ["move-1", "move-2"].map(|task_id| {
            let db_path = db_path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let conn = Connection::open(db_path).expect("writer connection");
                conn.busy_timeout(Duration::from_secs(5))
                    .expect("writer busy timeout");
                let scope = TaskMutationReadScope::patch(task_id, Some("project-b"), None, None);
                let patch = serde_json::json!({ "projectId": "project-b" })
                    .as_object()
                    .expect("project patch")
                    .clone();
                let mut mutation = |data: &mut Value| {
                    let task = crate::local_api::patch_task_in_data(data, task_id, &patch)?;
                    Ok::<_, String>(((), vec![task]))
                };
                barrier.wait();
                commit_task_row_mutation(&conn, &scope, &mut mutation)
                    .expect("concurrent project move");
            })
        });
        barrier.wait();
        for handle in handles {
            handle.join().expect("writer thread");
        }

        let verify = Connection::open(&db_path).expect("verify connection");
        let mut statement = verify
            .prepare(
                "SELECT projectId, sectionId, orderNum FROM tasks
                 WHERE id IN ('move-1', 'move-2') ORDER BY orderNum",
            )
            .expect("order query");
        let moved = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            })
            .expect("moved rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("valid moved rows");

        assert_eq!(
            moved,
            vec![
                ("project-b".to_string(), None, 6.0),
                ("project-b".to_string(), None, 7.0),
            ]
        );
    }

    #[test]
    fn saturated_revision_future_timestamp_does_not_discard_local_api_patch() {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(SQLITE_SCHEMA).expect("schema");
        replace_data_in_transaction(
            &conn,
            serde_json::json!({
                "tasks": [{
                    "id": "task-1", "title": "Original", "status": "next",
                    "tags": [], "contexts": [],
                    "rev": 2_147_483_647_i64, "revBy": "remote-clock",
                    "createdAt": "2026-07-31T10:00:00Z",
                    "updatedAt": "2099-01-01T00:00:00Z"
                }],
                "projects": [], "areas": [], "sections": [], "people": [],
                "settings": { "deviceId": "desktop-local-api" }
            }),
        )
        .expect("seed future-dated saturated row");
        let patch = serde_json::json!({ "title": "Patched" })
            .as_object()
            .expect("patch object")
            .clone();
        let scope = TaskMutationReadScope::existing("task-1", false);
        let mut mutation = |data: &mut Value| {
            let task = data["tasks"]
                .as_array_mut()
                .expect("tasks")
                .iter_mut()
                .find(|task| task["id"] == "task-1")
                .and_then(Value::as_object_mut)
                .expect("target task");
            crate::local_api::apply_task_patch(task, &patch, "desktop-local-api")?;
            Ok::<_, String>(((), vec![Value::Object(task.clone())]))
        };

        commit_task_row_mutation(&conn, &scope, &mut mutation).expect("commit patch");

        let persisted = conn
            .query_row(
                "SELECT * FROM tasks WHERE id = 'task-1'",
                [],
                row_to_task_value,
            )
            .expect("persisted task");
        assert_eq!(persisted["title"], "Patched");
        assert_eq!(persisted["rev"], 2_147_483_647_i64);
        assert_ne!(persisted["updatedAt"], "2099-01-01T00:00:00Z");
    }

    #[test]
    fn incremental_task_save_does_not_resurrect_an_observed_absent_task() {
        let conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");
        let temp = tempfile::tempdir().expect("tempdir");
        let data_path = temp.path().join("data.json");
        let baseline = serde_json::json!({
            "id": "task-observed", "title": "Observed", "status": "next",
            "tags": [], "contexts": [], "rev": 1,
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T10:00:00Z"
        });
        let stale_edit = serde_json::json!({
            "id": "task-observed", "title": "Stale edit", "status": "next",
            "tags": [], "contexts": [], "rev": 2,
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T11:00:00Z"
        });

        let canonical = persist_task_snapshot(&conn, &stale_edit, &data_path, Some(&baseline))
            .expect("guarded incremental save");
        assert_eq!(canonical["tasks"], serde_json::json!([]));

        let new_task = serde_json::json!({
            "id": "task-new", "title": "New", "status": "inbox",
            "tags": [], "contexts": [], "rev": 1,
            "createdAt": "2026-07-31T12:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
        });
        let canonical =
            persist_task_snapshot(&conn, &new_task, &data_path, None).expect("unobserved insert");
        assert_eq!(canonical["tasks"].as_array().expect("tasks").len(), 1);
        assert_eq!(canonical["tasks"][0]["id"], "task-new");
    }

    #[test]
    fn incremental_task_save_keeps_higher_revision_across_connections() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("data.db");
        let first = Connection::open(&db_path).expect("open first connection");
        first.execute_batch(SQLITE_SCHEMA).expect("create schema");
        let second = Connection::open(&db_path).expect("open second connection");
        second
            .execute_batch(SQLITE_SCHEMA)
            .expect("configure second connection");
        let data_path = temp.path().join("data.json");
        let task = |title: &str, rev: i64, updated_at: &str| {
            serde_json::json!({
                "id": "task-1", "title": title, "status": "next",
                "tags": [], "contexts": [], "rev": rev, "revBy": "writer-a",
                "createdAt": "2026-07-31T10:00:00Z", "updatedAt": updated_at
            })
        };

        persist_task_snapshot(
            &first,
            &task("Initial", 1, "2026-07-31T10:00:00Z"),
            &data_path,
            None,
        )
        .expect("initial save");
        persist_task_snapshot(
            &second,
            &task("Higher revision", 3, "2026-07-31T12:00:00Z"),
            &data_path,
            None,
        )
        .expect("higher revision save");
        let canonical = persist_task_snapshot(
            &first,
            &task("Stale retry", 2, "2026-07-31T11:00:00Z"),
            &data_path,
            None,
        )
        .expect("stale retry returns winner");

        assert_eq!(canonical["tasks"][0]["title"], "Higher revision");
        assert_eq!(canonical["tasks"][0]["rev"], 3);
        assert_eq!(
            read_json_with_retries(&data_path, 1).expect("recovery copy")["tasks"][0]["title"],
            "Higher revision"
        );
    }

    #[test]
    fn incremental_equal_revision_winner_is_arrival_order_independent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let task = |title: &str| {
            serde_json::json!({
                "id": "task-1", "title": title, "status": "next",
                "tags": [], "contexts": [], "rev": 3, "revBy": "writer-a",
                "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T12:00:00Z"
            })
        };
        let save_in_order = |db_name: &str, first: Value, second: Value| {
            let conn = Connection::open(temp.path().join(db_name)).expect("open database");
            conn.execute_batch(SQLITE_SCHEMA).expect("create schema");
            let data_path = temp.path().join(format!("{db_name}.json"));
            persist_task_snapshot(&conn, &first, &data_path, None).expect("first save");
            persist_task_snapshot(&conn, &second, &data_path, None).expect("second save")
        };

        let left = save_in_order("left.db", task("Alpha"), task("Zulu"));
        let right = save_in_order("right.db", task("Zulu"), task("Alpha"));
        assert_eq!(left["tasks"], right["tasks"]);
    }

    #[test]
    fn data_json_refresh_reloads_latest_sqlite_after_another_commit() {
        let temp = tempfile::tempdir().expect("tempdir");
        let db_path = temp.path().join("data.db");
        let mut first = Connection::open(&db_path).expect("open first connection");
        first.execute_batch(SQLITE_SCHEMA).expect("create schema");
        let mut second = Connection::open(&db_path).expect("open second connection");
        second
            .execute_batch(SQLITE_SCHEMA)
            .expect("configure second connection");
        let snapshot = |title: &str, rev: i64| {
            serde_json::json!({
                "tasks": [{
                    "id": "task-1", "title": title, "status": "next",
                    "tags": [], "contexts": [], "rev": rev,
                    "createdAt": "2026-07-31T10:00:00Z",
                    "updatedAt": format!("2026-07-31T1{}:00:00Z", rev)
                }],
                "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
            })
        };
        migrate_json_to_sqlite(&mut first, &snapshot("First commit", 1)).expect("first commit");
        let stale = read_sqlite_snapshot(&first).expect("capture stale canonical");
        migrate_json_to_sqlite(&mut second, &snapshot("Later commit", 2)).expect("later commit");
        let data_path = temp.path().join("data.json");
        write_data_json_file(&data_path, &stale).expect("seed stale recovery copy");

        let refreshed = refresh_data_json_from_sqlite(&first, &data_path)
            .expect("refresh committed canonical data");

        let mirrored = read_json_with_retries(&data_path, 1).expect("read recovery copy");
        assert_eq!(mirrored, refreshed);
        assert_eq!(mirrored["tasks"][0]["title"], "Later commit");
        assert_eq!(mirrored["tasks"][0]["rev"], 2);
    }

    #[test]
    fn full_save_merge_and_exact_release_writer_during_slow_publication() {
        for exact in [false, true] {
            let temp = tempfile::tempdir().expect("tempdir");
            let db_path = temp.path().join("data.db");
            let mut first = Connection::open(&db_path).expect("first connection");
            first.execute_batch(SQLITE_SCHEMA).expect("first schema");
            let second = Connection::open(&db_path).expect("second connection");
            second.execute_batch(SQLITE_SCHEMA).expect("second schema");
            let initial = serde_json::json!({
                "tasks": [{
                    "id": "task-1", "title": "Initial", "status": "next",
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-07-31T10:00:00Z",
                    "updatedAt": "2026-07-31T10:00:00Z"
                }],
                "projects": [], "areas": [], "sections": [], "people": [], "settings": {}
            });
            if exact {
                replace_json_in_sqlite(&mut first, &initial).expect("exact full save commit");
            } else {
                merge_json_to_sqlite(&mut first, &initial, None).expect("merge full save commit");
            }
            let (canonical, data_version) =
                stable_sqlite_snapshot_with_version(&first).expect("post-commit canonical");
            let data_path = temp.path().join("data.json");
            let publication_guard = data_json_publication_lock()
                .lock()
                .expect("hold slow publication gate");
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let publisher_barrier = barrier.clone();
            let publisher = std::thread::spawn(move || {
                publisher_barrier.wait();
                publish_task_data_json(&first, &data_path, canonical, data_version)
            });
            barrier.wait();

            let later = serde_json::json!({
                "id": "task-2", "title": "Concurrent", "status": "next",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-07-31T11:00:00Z",
                "updatedAt": "2026-07-31T11:00:00Z"
            });
            commit_task_snapshot(&second, &later, None)
                .expect("second writer commits while publication is blocked");
            drop(publication_guard);

            let published = publisher.join().expect("publisher thread");
            assert!(published["tasks"]
                .as_array()
                .expect("published tasks")
                .iter()
                .any(|task| task["id"] == "task-2"));
        }
    }

    #[test]
    fn sanitize_dangling_container_references_nulls_and_reports_task_and_project_refs() {
        let mut data = serde_json::json!({
            "areas": [{ "id": "area-live" }],
            "projects": [
                { "id": "project-live" },
                {
                    "id": "project-dangling-area", "areaId": "area-missing",
                    "rev": 2, "revBy": "old-project-writer",
                    "updatedAt": "2026-07-01T00:00:00Z"
                }
            ],
            "tasks": [{
                "id": "task-1",
                "projectId": "project-missing",
                "sectionId": "section-missing",
                "areaId": "area-live",
                "rev": 3, "revBy": "old-task-writer",
                "updatedAt": "2026-07-01T00:00:00Z"
            }],
            "settings": { "deviceId": "repair-device" }
        });

        let issues = sanitize_dangling_container_references(&mut data);

        assert_eq!(
            data["projects"][1].get("areaId"),
            None,
            "dangling project.areaId should be nulled"
        );
        assert_eq!(data["tasks"][0].get("projectId"), None);
        assert_eq!(data["tasks"][0].get("sectionId"), None);
        assert_eq!(
            data["tasks"][0]["areaId"], "area-live",
            "a live areaId must survive untouched"
        );
        assert_eq!(data["projects"][1]["rev"], 3);
        assert_eq!(data["projects"][1]["revBy"], "repair-device");
        assert_ne!(data["projects"][1]["updatedAt"], "2026-07-01T00:00:00Z");
        assert_eq!(data["tasks"][0]["rev"], 4);
        assert_eq!(data["tasks"][0]["revBy"], "repair-device");
        assert_ne!(data["tasks"][0]["updatedAt"], "2026-07-01T00:00:00Z");

        let kinds: Vec<&str> = issues.iter().map(|(kind, _, _)| *kind).collect();
        assert!(kinds.contains(&"project.areaId"));
        assert!(kinds.contains(&"task.projectId"));
        assert!(kinds.contains(&"task.sectionId"));
        assert!(!kinds.contains(&"task.areaId"));

        let settled = data.clone();
        assert!(sanitize_dangling_container_references(&mut data).is_empty());
        assert_eq!(data, settled, "revision-stamped repairs are idempotent");
    }

    #[test]
    fn sanitize_dangling_container_references_tombstones_section_with_missing_project() {
        let mut data = serde_json::json!({
            "areas": [],
            "projects": [{ "id": "project-live" }],
            "sections": [
                { "id": "section-live", "projectId": "project-live" },
                {
                    "id": "section-orphan", "projectId": "project-missing",
                    "rev": 4, "revBy": "old-writer",
                    "createdAt": "2026-07-01T00:00:00Z",
                    "updatedAt": "2026-07-01T00:00:00Z"
                }
            ],
            "tasks": [],
            "settings": { "deviceId": "repair-device" }
        });

        let issues = sanitize_dangling_container_references(&mut data);

        let remaining_section_ids: Vec<&str> = data["sections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|section| section["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            remaining_section_ids,
            vec!["section-live", "section-orphan"]
        );
        let orphan = data["sections"]
            .as_array()
            .expect("sections")
            .iter()
            .find(|section| section["id"] == "section-orphan")
            .expect("orphan tombstone");
        assert!(orphan.get("deletedAt").and_then(Value::as_str).is_some());
        assert_eq!(orphan["updatedAt"], orphan["deletedAt"]);
        assert_eq!(orphan["rev"], 5);
        assert_eq!(orphan["revBy"], "repair-device");
        assert!(issues
            .iter()
            .any(|(kind, id, missing)| *kind == "section.projectId"
                && id == "section-orphan"
                && missing == "project-missing"));

        let settled = data.clone();
        assert!(sanitize_dangling_container_references(&mut data).is_empty());
        assert_eq!(data, settled, "repair is idempotent");
    }

    #[test]
    fn exact_and_merge_clear_missing_container_refs_from_deleted_entities() {
        let deleted_at = "2026-08-01T00:00:00Z";
        let input = serde_json::json!({
            "tasks": [{
                "id": "task-deleted", "title": "Deleted task", "status": "next",
                "projectId": "project-missing", "sectionId": "section-missing",
                "areaId": "area-missing", "tags": [], "contexts": [],
                "deletedAt": deleted_at, "rev": 7, "revBy": "remote-a",
                "createdAt": "2026-07-01T00:00:00Z", "updatedAt": deleted_at
            }],
            "projects": [{
                "id": "project-deleted", "title": "Deleted project", "status": "active",
                "color": "#000000", "tagIds": [], "areaId": "area-missing",
                "deletedAt": deleted_at, "rev": 5, "revBy": "remote-a",
                "createdAt": "2026-07-01T00:00:00Z", "updatedAt": deleted_at
            }],
            "sections": [], "areas": [], "people": [],
            "settings": { "deviceId": "repair-device" }
        });

        for exact in [true, false] {
            let mut conn = Connection::open_in_memory().expect("database");
            conn.execute_batch(SQLITE_SCHEMA).expect("schema");
            let canonical = if exact {
                replace_json_in_sqlite(&mut conn, &input).expect("exact write")
            } else {
                merge_json_to_sqlite(&mut conn, &input, None).expect("merge write")
            };

            let project = &canonical["projects"][0];
            let task = &canonical["tasks"][0];
            assert!(project.get("areaId").is_none());
            assert!(task.get("projectId").is_none());
            assert!(task.get("sectionId").is_none());
            assert!(task.get("areaId").is_none());
            assert_eq!(
                project["rev"], 5,
                "repair must not revive the project tombstone"
            );
            assert_eq!(project["updatedAt"], deleted_at);
            assert_eq!(task["rev"], 7, "repair must not revive the task tombstone");
            assert_eq!(task["updatedAt"], deleted_at);
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("foreign key check"),
                0
            );
        }
    }

    #[test]
    fn orphan_section_tombstone_survives_exact_and_merge_round_trips() {
        let mut conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(SQLITE_SCHEMA).expect("schema");
        let input = serde_json::json!({
            "tasks": [], "projects": [], "areas": [], "people": [],
            "sections": [{
                "id": "section-orphan", "projectId": "project-missing", "title": "Preserve me",
                "order": 0, "rev": 8, "revBy": "remote-a",
                "createdAt": "2026-07-01T00:00:00Z",
                "updatedAt": "2026-07-01T00:00:00Z"
            }],
            "settings": { "deviceId": "desktop-repair" }
        });

        let exact = replace_json_in_sqlite(&mut conn, &input).expect("exact repair");
        let repaired = exact["sections"].as_array().expect("sections");
        assert_eq!(repaired.len(), 1);
        assert_eq!(repaired[0]["id"], "section-orphan");
        assert!(repaired[0].get("deletedAt").is_some());
        assert_eq!(repaired[0]["rev"], 9);
        assert_eq!(repaired[0]["revBy"], "desktop-repair");
        assert_eq!(
            read_sqlite_data(&conn).expect("canonical read")["sections"],
            exact["sections"]
        );
        let first_sidecar_payload: String = conn
            .query_row(
                "SELECT data FROM orphan_section_tombstones WHERE id = 'section-orphan'",
                [],
                |row| row.get(0),
            )
            .expect("sidecar payload");

        let exact_again = replace_json_in_sqlite(&mut conn, &exact).expect("second exact write");
        assert_eq!(exact_again["sections"], exact["sections"]);
        let second_sidecar_payload: String = conn
            .query_row(
                "SELECT data FROM orphan_section_tombstones WHERE id = 'section-orphan'",
                [],
                |row| row.get(0),
            )
            .expect("stable sidecar payload");
        assert_eq!(second_sidecar_payload, first_sidecar_payload);
        let merged = merge_json_to_sqlite(&mut conn, &exact_again, None).expect("sync-style merge");
        assert_eq!(merged["sections"], exact["sections"]);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("foreign key check"),
            0
        );

        let mut cleaned = merged.clone();
        cleaned["sections"] = Value::Array(Vec::new());
        let cleaned = replace_json_in_sqlite(&mut conn, &cleaned).expect("retention cleanup write");
        assert!(cleaned["sections"].as_array().expect("sections").is_empty());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM orphan_section_tombstones", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("bounded sidecar"),
            0,
            "when canonical tombstone retention purges the section, the sidecar is purged transactionally"
        );

        replace_json_in_sqlite(&mut conn, &input).expect("reseed orphan tombstone");
        let live_winner = serde_json::json!({
            "tasks": [], "areas": [], "people": [],
            "projects": [{
                "id": "project-missing", "title": "Recovered project", "status": "active",
                "color": "#000000", "order": 0, "tagIds": [], "rev": 10, "revBy": "remote-b",
                "createdAt": "2026-07-01T00:00:00Z", "updatedAt": "2030-01-01T00:00:00Z"
            }],
            "sections": [{
                "id": "section-orphan", "projectId": "project-missing", "title": "Recovered section",
                "order": 0, "rev": 10, "revBy": "remote-b",
                "createdAt": "2026-07-01T00:00:00Z", "updatedAt": "2030-01-01T00:00:00Z"
            }],
            "settings": { "deviceId": "desktop-repair" }
        });
        let recovered = merge_json_to_sqlite(&mut conn, &live_winner, None)
            .expect("higher-revision live winner");
        assert_eq!(recovered["sections"].as_array().map(Vec::len), Some(1));
        assert_eq!(recovered["sections"][0]["title"], "Recovered section");
        assert!(recovered["sections"][0].get("deletedAt").is_none());
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM orphan_section_tombstones",
                [],
                |row| { row.get::<_, i64>(0) }
            )
            .expect("sidecar winner cleanup"),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sections WHERE id = 'section-orphan'",
                [],
                |row| { row.get::<_, i64>(0) }
            )
            .expect("live section row"),
            1
        );
    }

    #[test]
    fn exact_write_ignores_a_spoofed_orphan_section_marker() {
        let mut conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(SQLITE_SCHEMA).expect("schema");
        let input = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "Keep organized", "status": "next",
                "projectId": "project-live", "sectionId": "section-live",
                "tags": [], "contexts": [], "rev": 1, "revBy": "remote-a",
                "createdAt": "2026-08-01T10:00:00Z",
                "updatedAt": "2026-08-01T10:00:00Z"
            }],
            "projects": [{
                "id": "project-live", "title": "Live", "status": "active",
                "color": "#000000", "tagIds": [], "rev": 1, "revBy": "remote-a",
                "createdAt": "2026-08-01T10:00:00Z",
                "updatedAt": "2026-08-01T10:00:00Z"
            }],
            "sections": [{
                "id": "section-live", "projectId": "project-live", "title": "Live section",
                "order": 0, "rev": 1, "revBy": "remote-a",
                "createdAt": "2026-08-01T10:00:00Z",
                "updatedAt": "2026-08-01T10:00:00Z",
                "_mindwtrOrphanSectionTombstone": true
            }],
            "areas": [], "people": [], "settings": { "deviceId": "desktop-a" }
        });

        let canonical = replace_json_in_sqlite(&mut conn, &input)
            .expect("an untrusted marker cannot divert a live section");

        assert_eq!(canonical["sections"].as_array().map(Vec::len), Some(1));
        assert_eq!(canonical["sections"][0]["id"], "section-live");
        assert!(canonical["sections"][0]
            .get("_mindwtrOrphanSectionTombstone")
            .is_none());
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sections WHERE id = 'section-live'",
                [],
                |row| { row.get::<_, i64>(0) }
            )
            .expect("primary section row"),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM orphan_section_tombstones",
                [],
                |row| { row.get::<_, i64>(0) }
            )
            .expect("sidecar count"),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("foreign key check"),
            0
        );
    }

    #[test]
    fn snapshot_merge_matches_shared_core_entity_arbitration_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/sync-entity-arbitration-parity.fixtures.json"
        ))
        .expect("valid entity arbitration parity fixture");
        assert_eq!(fixture.get("version").and_then(Value::as_u64), Some(1));
        let cases = fixture
            .get("cases")
            .and_then(Value::as_array)
            .expect("fixture cases");
        assert_eq!(cases.len(), 18, "fixture cardinality is pinned");

        let expected_category_counts = HashMap::from([
            ("backup-resurrection", 1),
            ("comparable-signature-tie", 1),
            ("date-only-timestamp", 1),
            ("delete-live", 3),
            ("exact-signature-tie", 1),
            ("future-clamping", 1),
            ("invalid-timestamp", 1),
            ("purged-at", 1),
            ("rev-by-both", 1),
            ("rev-by-missing", 1),
            ("revision-dominance", 1),
            ("revision-vs-delete-window", 2),
            ("revisionless-skew", 2),
            ("timestamp-offset-equivalence", 1),
        ]);
        let mut category_counts = HashMap::new();
        for test_case in cases {
            let category = test_case
                .get("category")
                .and_then(Value::as_str)
                .expect("fixture category");
            *category_counts.entry(category).or_insert(0) += 1;
        }
        assert_eq!(category_counts, expected_category_counts);

        let snapshot = |task: &Value| {
            serde_json::json!({
                "tasks": [task.clone()],
                "projects": [],
                "sections": [],
                "areas": [],
                "people": [],
                "settings": {}
            })
        };
        for test_case in cases {
            let name = test_case
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unnamed arbitration case");
            let now_iso = test_case
                .get("nowIso")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("missing nowIso for {name}"));
            let merge_now = parse_entity_timestamp(Some(&Value::String(now_iso.to_string())))
                .unwrap_or_else(|| panic!("invalid nowIso for {name}"));
            let left = test_case
                .get("left")
                .unwrap_or_else(|| panic!("missing left task for {name}"));
            let right = test_case
                .get("right")
                .unwrap_or_else(|| panic!("missing right task for {name}"));
            let expected = test_case
                .get("expected")
                .and_then(Value::as_object)
                .unwrap_or_else(|| panic!("missing expected result for {name}"));
            let expected_task = |direction: &str| {
                let side = expected
                    .get(direction)
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| panic!("missing {direction} winner for {name}"));
                match side {
                    "left" => left,
                    "right" => right,
                    _ => panic!("invalid {direction} winner for {name}"),
                }
            };

            let forward =
                merge_data_snapshots_at(&snapshot(left), &snapshot(right), None, merge_now);
            let reverse =
                merge_data_snapshots_at(&snapshot(right), &snapshot(left), None, merge_now);
            assert_eq!(
                forward["tasks"][0],
                *expected_task("forward"),
                "forward arbitration for {name}"
            );
            assert_eq!(
                reverse["tasks"][0],
                *expected_task("reverse"),
                "reverse arbitration for {name}"
            );
            if expected
                .get("converges")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                assert_eq!(
                    forward["tasks"][0], reverse["tasks"][0],
                    "convergence for {name}"
                );
            }

            if test_case.get("category").and_then(Value::as_str) == Some("exact-signature-tie") {
                assert_eq!(left, right, "exact tie inputs for {name}");
                assert_eq!(
                    expected.get("forward").and_then(Value::as_str),
                    Some("right")
                );
                assert_eq!(
                    expected.get("reverse").and_then(Value::as_str),
                    Some("left")
                );
            }
        }
    }

    #[test]
    fn migrate_json_to_sqlite_succeeds_on_a_snapshot_with_a_dangling_project_reference() {
        // What used to brick first load once the FK columns were added
        // (#rust-write-parity review): a task referencing a project that no
        // longer exists must not fail the FK-enforced insert - it lands with
        // the dangling reference nulled, same as ON DELETE SET NULL would
        // have produced.
        let mut conn = Connection::open_in_memory().expect("should open in-memory db");
        conn.execute_batch(SQLITE_SCHEMA)
            .expect("should create schema");

        let data = serde_json::json!({
            "tasks": [{
                "id": "task-orphan",
                "title": "Orphaned task",
                "status": "next",
                "projectId": "project-does-not-exist",
                "tags": [],
                "contexts": [],
                "createdAt": "2026-07-30T00:00:00.000Z",
                "updatedAt": "2026-07-30T00:00:00.000Z"
            }],
            "projects": [],
            "areas": [],
            "sections": [],
            "people": [],
            "settings": {}
        });

        migrate_json_to_sqlite(&mut conn, &data)
            .expect("migration must not fail on a dangling container reference");
        let read = read_sqlite_data(&conn).expect("should read data");
        let task = read["tasks"]
            .as_array()
            .and_then(|tasks| tasks.first())
            .expect("task should exist");
        assert_eq!(task.get("projectId"), None);
    }

    // create_data_snapshot/restore_data_snapshot need a real tauri::AppHandle,
    // which this crate has no test harness to construct — this proves the
    // lock those commands share (lock_snapshot_operation) actually serializes
    // two concurrent holders, the mechanism they rely on now that both run
    // off the main thread.
    #[test]
    fn snapshot_operation_lock_blocks_a_concurrent_holder() {
        let guard = lock_snapshot_operation().expect("first holder acquires");
        assert!(
            snapshot_operation_lock().try_lock().is_err(),
            "a second holder must not acquire while the first is still held"
        );
        drop(guard);
        assert!(
            snapshot_operation_lock().try_lock().is_ok(),
            "the lock must be free again once the first holder releases"
        );
    }
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
        if !matches!(map.get("sections"), Some(Value::Array(_))) {
            map.insert("sections".to_string(), Value::Array(Vec::new()));
        }
        if !matches!(map.get("people"), Some(Value::Array(_))) {
            map.insert("people".to_string(), Value::Array(Vec::new()));
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
        "sections": [],
        "people": [],
        "settings": {}
    })
}

pub(crate) fn read_json_with_retries_validated<Validate>(
    path: &Path,
    attempts: usize,
    validate: Validate,
) -> Result<Value, String>
where
    Validate: Fn(&Value) -> Result<(), String>,
{
    read_json_with_retries_decoded(
        path,
        attempts,
        |path| fs::read_to_string(path).map_err(|error| error.to_string()),
        validate,
    )
}

/// Same retry/eviction/backoff behavior as `read_json_with_retries_validated`, with the
/// bytes-to-JSON-text step supplied by the caller. The sync-encryption seam passes a decoder
/// that reads raw bytes and decrypts them (#1056); every other caller passes the plain
/// `read_to_string` above, whose behavior is unchanged.
pub(crate) fn read_json_with_retries_decoded<Decode, Validate>(
    path: &Path,
    attempts: usize,
    decode: Decode,
    validate: Validate,
) -> Result<Value, String>
where
    Decode: Fn(&Path) -> Result<String, String>,
    Validate: Fn(&Value) -> Result<(), String>,
{
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

        match decode(path) {
            Ok(content) => match parse_json_relaxed(&content) {
                Ok(value) => match validate(&value) {
                    Ok(()) => return Ok(normalize_sync_value(value)),
                    Err(error) => last_err = Some(error),
                },
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

pub(crate) fn read_json_with_retries(path: &Path, attempts: usize) -> Result<Value, String> {
    read_json_with_retries_validated(path, attempts, |_| Ok(()))
}
