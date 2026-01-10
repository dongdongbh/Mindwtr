use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::env;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::image::Image;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use rusqlite::{params, Connection, OptionalExtension, params_from_iter, ToSql};
use keyring::{Entry, Error as KeyringError};

/// App name used for config directories and files
const APP_NAME: &str = "mindwtr";
const CONFIG_FILE_NAME: &str = "config.toml";
const SECRETS_FILE_NAME: &str = "secrets.toml";
const DATA_FILE_NAME: &str = "data.json";
const DB_FILE_NAME: &str = "mindwtr.db";
const KEYRING_WEB_DAV_PASSWORD: &str = "webdav_password";
const KEYRING_CLOUD_TOKEN: &str = "cloud_token";
const KEYRING_AI_OPENAI: &str = "ai_key_openai";
const KEYRING_AI_ANTHROPIC: &str = "ai_key_anthropic";
const KEYRING_AI_GEMINI: &str = "ai_key_gemini";

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
  orderNum INTEGER,
  isFocusedToday INTEGER,
  timeEstimate TEXT,
  reviewAt TEXT,
  completedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT,
  purgedAt TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  color TEXT NOT NULL,
  tagIds TEXT,
  isSequential INTEGER,
  isFocused INTEGER,
  supportNotes TEXT,
  attachments TEXT,
  reviewAt TEXT,
  areaId TEXT,
  areaTitle TEXT,
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
  createdAt TEXT,
  updatedAt TEXT
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
  DELETE FROM tasks_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  DELETE FROM tasks_fts WHERE id = old.id;
  INSERT INTO tasks_fts (id, title, description, tags, contexts)
  VALUES (new.id, new.title, coalesce(new.description, ''), coalesce(new.tags, ''), coalesce(new.contexts, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
  INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
  VALUES (new.id, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
END;

CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
  DELETE FROM projects_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
  DELETE FROM projects_fts WHERE id = old.id;
  INSERT INTO projects_fts (id, title, supportNotes, tagIds, areaTitle)
  VALUES (new.id, new.title, coalesce(new.supportNotes, ''), coalesce(new.tagIds, ''), coalesce(new.areaTitle, ''));
END;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_projectId ON tasks(projectId);
CREATE INDEX IF NOT EXISTS idx_tasks_deletedAt ON tasks(deletedAt);
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
    sync_backend: Option<String>,
    webdav_url: Option<String>,
    webdav_username: Option<String>,
    webdav_password: Option<String>,
    cloud_url: Option<String>,
    cloud_token: Option<String>,
    external_calendars: Option<String>,
    ai_key_openai: Option<String>,
    ai_key_anthropic: Option<String>,
    ai_key_gemini: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ExternalCalendarSubscription {
    id: String,
    name: String,
    url: String,
    enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct LinuxDistroInfo {
    id: Option<String>,
    id_like: Vec<String>,
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

#[tauri::command]
fn consume_quick_add_pending(state: tauri::State<'_, QuickAddPending>) -> bool {
    state.0.swap(false, Ordering::SeqCst)
}

#[tauri::command]
fn log_ai_debug(context: String, message: String, provider: Option<String>, model: Option<String>, task_id: Option<String>) {
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
        .expect("failed to resolve app config root dir")
}

fn get_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .resolve(APP_NAME, BaseDirectory::Data)
        .expect("failed to resolve app data root dir")
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
    conn.execute_batch(SQLITE_SCHEMA).map_err(|e| e.to_string())?;
    ensure_tasks_purged_at_column(&conn)?;
    ensure_tasks_order_column(&conn)?;
    ensure_fts_populated(&conn, false)?;
    Ok(conn)
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
        conn.execute("DELETE FROM tasks_fts", []).map_err(|e| e.to_string())?;
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
        conn.execute("DELETE FROM projects_fts", []).map_err(|e| e.to_string())?;
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
    map.insert("title".to_string(), Value::String(row.get::<_, String>("title")?));
    map.insert("status".to_string(), Value::String(row.get::<_, String>("status")?));
    if let Ok(val) = row.get::<_, Option<String>>("priority") {
        if let Some(v) = val { map.insert("priority".to_string(), Value::String(v)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("taskMode") {
        if let Some(v) = val { map.insert("taskMode".to_string(), Value::String(v)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("startTime") {
        if let Some(v) = val { map.insert("startTime".to_string(), Value::String(v)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("dueDate") {
        if let Some(v) = val { map.insert("dueDate".to_string(), Value::String(v)); }
    }
    let recurrence_raw: Option<String> = row.get("recurrence")?;
    let recurrence_val = parse_json_value(recurrence_raw);
    if !recurrence_val.is_null() {
        map.insert("recurrence".to_string(), recurrence_val);
    }
    if let Ok(val) = row.get::<_, Option<i64>>("pushCount") {
        if let Some(v) = val { map.insert("pushCount".to_string(), Value::Number(v.into())); }
    }
    let tags_raw: Option<String> = row.get("tags")?;
    map.insert("tags".to_string(), parse_json_array(tags_raw));
    let contexts_raw: Option<String> = row.get("contexts")?;
    map.insert("contexts".to_string(), parse_json_array(contexts_raw));
    let checklist_raw: Option<String> = row.get("checklist")?;
    let checklist_val = parse_json_value(checklist_raw);
    if !checklist_val.is_null() { map.insert("checklist".to_string(), checklist_val); }
    if let Ok(val) = row.get::<_, Option<String>>("description") {
        if let Some(v) = val { map.insert("description".to_string(), Value::String(v)); }
    }
    let attachments_raw: Option<String> = row.get("attachments")?;
    let attachments_val = parse_json_value(attachments_raw);
    if !attachments_val.is_null() { map.insert("attachments".to_string(), attachments_val); }
    if let Ok(val) = row.get::<_, Option<String>>("location") {
        if let Some(v) = val { map.insert("location".to_string(), Value::String(v)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("projectId") {
        if let Some(v) = val { map.insert("projectId".to_string(), Value::String(v)); }
    }
    if let Ok(val) = row.get::<_, Option<i64>>("orderNum") {
        if let Some(v) = val { map.insert("orderNum".to_string(), Value::Number(v.into())); }
    }
    if let Ok(val) = row.get::<_, i64>("isFocusedToday") {
        if val != 0 { map.insert("isFocusedToday".to_string(), Value::Bool(true)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("timeEstimate") {
        if let Some(v) = val { map.insert("timeEstimate".to_string(), Value::String(v)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("reviewAt") {
        if let Some(v) = val { map.insert("reviewAt".to_string(), Value::String(v)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("completedAt") {
        if let Some(v) = val { map.insert("completedAt".to_string(), Value::String(v)); }
    }
    map.insert("createdAt".to_string(), Value::String(row.get::<_, String>("createdAt")?));
    map.insert("updatedAt".to_string(), Value::String(row.get::<_, String>("updatedAt")?));
    if let Ok(val) = row.get::<_, Option<String>>("deletedAt") {
        if let Some(v) = val { map.insert("deletedAt".to_string(), Value::String(v)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("purgedAt") {
        if let Some(v) = val { map.insert("purgedAt".to_string(), Value::String(v)); }
    }
    Ok(Value::Object(map))
}

fn row_to_project_value(row: &rusqlite::Row<'_>) -> Result<Value, rusqlite::Error> {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), Value::String(row.get::<_, String>("id")?));
    map.insert("title".to_string(), Value::String(row.get::<_, String>("title")?));
    map.insert("status".to_string(), Value::String(row.get::<_, String>("status")?));
    map.insert("color".to_string(), Value::String(row.get::<_, String>("color")?));
    let tag_ids_raw: Option<String> = row.get("tagIds")?;
    map.insert("tagIds".to_string(), parse_json_array(tag_ids_raw));
    if let Ok(val) = row.get::<_, i64>("isSequential") {
        if val != 0 { map.insert("isSequential".to_string(), Value::Bool(true)); }
    }
    if let Ok(val) = row.get::<_, i64>("isFocused") {
        if val != 0 { map.insert("isFocused".to_string(), Value::Bool(true)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("supportNotes") {
        if let Some(v) = val { map.insert("supportNotes".to_string(), Value::String(v)); }
    }
    let attachments_raw: Option<String> = row.get("attachments")?;
    let attachments_val = parse_json_value(attachments_raw);
    if !attachments_val.is_null() { map.insert("attachments".to_string(), attachments_val); }
    if let Ok(val) = row.get::<_, Option<String>>("reviewAt") {
        if let Some(v) = val { map.insert("reviewAt".to_string(), Value::String(v)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("areaId") {
        if let Some(v) = val { map.insert("areaId".to_string(), Value::String(v)); }
    }
    if let Ok(val) = row.get::<_, Option<String>>("areaTitle") {
        if let Some(v) = val { map.insert("areaTitle".to_string(), Value::String(v)); }
    }
    map.insert("createdAt".to_string(), Value::String(row.get::<_, String>("createdAt")?));
    map.insert("updatedAt".to_string(), Value::String(row.get::<_, String>("updatedAt")?));
    if let Ok(val) = row.get::<_, Option<String>>("deletedAt") {
        if let Some(v) = val { map.insert("deletedAt".to_string(), Value::String(v)); }
    }
    Ok(Value::Object(map))
}

fn migrate_json_to_sqlite(conn: &mut Connection, data: &Value) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM tasks", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM projects", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM areas", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM settings", []).map_err(|e| e.to_string())?;

    let tasks = data.get("tasks").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    for task in tasks {
        let tags_json = json_str_or_default(task.get("tags"), "[]");
        let contexts_json = json_str_or_default(task.get("contexts"), "[]");
        let recurrence_json = json_str(task.get("recurrence"));
        let checklist_json = json_str(task.get("checklist"));
        let attachments_json = json_str(task.get("attachments"));
        tx.execute(
            "INSERT INTO tasks (id, title, status, priority, taskMode, startTime, dueDate, recurrence, pushCount, tags, contexts, checklist, description, attachments, location, projectId, orderNum, isFocusedToday, timeEstimate, reviewAt, completedAt, createdAt, updatedAt, deletedAt, purgedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
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
                task.get("orderNum").and_then(|v| v.as_i64()),
                task.get("isFocusedToday").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                task.get("timeEstimate").and_then(|v| v.as_str()),
                task.get("reviewAt").and_then(|v| v.as_str()),
                task.get("completedAt").and_then(|v| v.as_str()),
                task.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("deletedAt").and_then(|v| v.as_str()),
                task.get("purgedAt").and_then(|v| v.as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let projects = data.get("projects").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    for project in projects {
        let tag_ids_json = json_str_or_default(project.get("tagIds"), "[]");
        let attachments_json = json_str(project.get("attachments"));
        tx.execute(
            "INSERT INTO projects (id, title, status, color, tagIds, isSequential, isFocused, supportNotes, attachments, reviewAt, areaId, areaTitle, createdAt, updatedAt, deletedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                project.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("title").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("status").and_then(|v| v.as_str()).unwrap_or("active"),
                project.get("color").and_then(|v| v.as_str()).unwrap_or("#6B7280"),
                tag_ids_json,
                project.get("isSequential").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                project.get("isFocused").and_then(|v| v.as_bool()).unwrap_or(false) as i32,
                project.get("supportNotes").and_then(|v| v.as_str()),
                attachments_json,
                project.get("reviewAt").and_then(|v| v.as_str()),
                project.get("areaId").and_then(|v| v.as_str()),
                project.get("areaTitle").and_then(|v| v.as_str()),
                project.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
                project.get("deletedAt").and_then(|v| v.as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let areas = data.get("areas").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    for area in areas {
        tx.execute(
            "INSERT INTO areas (id, name, color, icon, orderNum, createdAt, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                area.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                area.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
                area.get("color").and_then(|v| v.as_str()),
                area.get("icon").and_then(|v| v.as_str()),
                area.get("order").and_then(|v| v.as_i64()).unwrap_or(0),
                area.get("createdAt").and_then(|v| v.as_str()),
                area.get("updatedAt").and_then(|v| v.as_str()),
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

    let mut areas_stmt = conn
        .prepare("SELECT * FROM areas")
        .map_err(|e| e.to_string())?;
    let area_rows = areas_stmt
        .query_map([], |row| {
            let mut map = serde_json::Map::new();
            map.insert("id".to_string(), Value::String(row.get::<_, String>("id")?));
            map.insert("name".to_string(), Value::String(row.get::<_, String>("name")?));
            if let Ok(val) = row.get::<_, Option<String>>("color") {
                if let Some(v) = val { map.insert("color".to_string(), Value::String(v)); }
            }
            if let Ok(val) = row.get::<_, Option<String>>("icon") {
                if let Some(v) = val { map.insert("icon".to_string(), Value::String(v)); }
            }
            map.insert("order".to_string(), Value::Number((row.get::<_, i64>("orderNum")?).into()));
            if let Ok(val) = row.get::<_, Option<String>>("createdAt") {
                if let Some(v) = val { map.insert("createdAt".to_string(), Value::String(v)); }
            }
            if let Ok(val) = row.get::<_, Option<String>>("updatedAt") {
                if let Some(v) = val { map.insert("updatedAt".to_string(), Value::String(v)); }
            }
            Ok(Value::Object(map))
        })
        .map_err(|e| e.to_string())?;
    let mut areas: Vec<Value> = Vec::new();
    for row in area_rows {
        areas.push(row.map_err(|e| e.to_string())?);
    }

    let settings_raw: Option<String> = conn
        .query_row("SELECT data FROM settings WHERE id = 1", [], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let settings_val = parse_json_value(settings_raw).as_object().cloned().unwrap_or_default();

    Ok(Value::Object(
        serde_json::json!({
            "tasks": tasks,
            "projects": projects,
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
        .expect("failed to get legacy app config dir")
        .join("config.json")
}

fn get_legacy_data_json_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to get legacy app data dir")
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
    if let Some(stripped) = trimmed.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
        return Some(stripped.to_string());
    }
    None
}

fn parse_os_release_value(raw: &str) -> String {
    parse_toml_string_value(raw).unwrap_or_else(|| {
        raw.trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string()
    })
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

fn write_config_toml_with_header(path: &Path, config: &AppConfigToml, header: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push(header.to_string());
    if let Some(sync_path) = &config.sync_path {
        lines.push(format!("sync_path = {}", serialize_toml_string_value(sync_path)));
    }
    if let Some(sync_backend) = &config.sync_backend {
        lines.push(format!("sync_backend = {}", serialize_toml_string_value(sync_backend)));
    }
    if let Some(webdav_url) = &config.webdav_url {
        lines.push(format!("webdav_url = {}", serialize_toml_string_value(webdav_url)));
    }
    if let Some(webdav_username) = &config.webdav_username {
        lines.push(format!("webdav_username = {}", serialize_toml_string_value(webdav_username)));
    }
    if let Some(webdav_password) = &config.webdav_password {
        lines.push(format!("webdav_password = {}", serialize_toml_string_value(webdav_password)));
    }
    if let Some(cloud_url) = &config.cloud_url {
        lines.push(format!("cloud_url = {}", serialize_toml_string_value(cloud_url)));
    }
    if let Some(cloud_token) = &config.cloud_token {
        lines.push(format!("cloud_token = {}", serialize_toml_string_value(cloud_token)));
    }
    if let Some(external_calendars) = &config.external_calendars {
        lines.push(format!("external_calendars = {}", serialize_toml_string_value(external_calendars)));
    }
    if let Some(ai_key_openai) = &config.ai_key_openai {
        lines.push(format!("ai_key_openai = {}", serialize_toml_string_value(ai_key_openai)));
    }
    if let Some(ai_key_anthropic) = &config.ai_key_anthropic {
        lines.push(format!("ai_key_anthropic = {}", serialize_toml_string_value(ai_key_anthropic)));
    }
    if let Some(ai_key_gemini) = &config.ai_key_gemini {
        lines.push(format!("ai_key_gemini = {}", serialize_toml_string_value(ai_key_gemini)));
    }
    let content = format!("{}\n", lines.join("\n"));
    fs::write(path, content).map_err(|e| e.to_string())
}

fn merge_config(base: &mut AppConfigToml, overrides: AppConfigToml) {
    if overrides.sync_path.is_some() {
        base.sync_path = overrides.sync_path;
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
        || config.sync_backend.is_some()
        || config.webdav_url.is_some()
        || config.webdav_username.is_some()
        || config.webdav_password.is_some()
        || config.cloud_url.is_some()
        || config.cloud_token.is_some()
        || config.external_calendars.is_some()
        || config.ai_key_openai.is_some()
        || config.ai_key_anthropic.is_some()
        || config.ai_key_gemini.is_some()
}

fn write_config_files(config_path: &Path, secrets_path: &Path, config: &AppConfigToml) -> Result<(), String> {
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

fn set_keyring_secret(app: &tauri::AppHandle, key: &str, value: Option<String>) -> Result<(), String> {
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

fn bootstrap_storage_layout(app: &tauri::AppHandle) -> Result<(), String> {
    let config_dir = get_config_dir(app);
    let data_dir = get_data_dir(app);
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let legacy_config_path = get_legacy_config_json_path(app);
    let legacy_config: LegacyAppConfigJson = if let Ok(content) = fs::read_to_string(&legacy_config_path) {
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
        fs::write(&data_path, serde_json::to_string_pretty(&initial_data).unwrap())
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn ensure_data_file(app: &tauri::AppHandle) -> Result<(), String> {
    bootstrap_storage_layout(app)
}

#[tauri::command]
fn get_data(app: tauri::AppHandle) -> Result<Value, String> {
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
fn save_data(app: tauri::AppHandle, data: Value) -> Result<bool, String> {
    ensure_data_file(&app)?;
    let mut conn = open_sqlite(&app)?;
    migrate_json_to_sqlite(&mut conn, &data)?;

    // Keep JSON backup updated for safety/rollbacks
    let data_path = get_data_path(&app);
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let backup_path = data_path.with_extension("json.bak");
    if data_path.exists() {
        let _ = fs::copy(&data_path, &backup_path);
    }
    let tmp_path = data_path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    {
        let mut file = File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    if cfg!(windows) && data_path.exists() {
        fs::remove_file(&data_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_path, &data_path).map_err(|e| e.to_string())?;
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
        .query_map(params_from_iter(params.iter().map(|p| p.as_ref())), |row| row_to_task_value(row))
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
fn set_ai_key(app: tauri::AppHandle, provider: String, value: Option<String>) -> Result<(), String> {
    let next_value = value.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    });
    let key_name = match provider.as_str() {
        "openai" => KEYRING_AI_OPENAI,
        "anthropic" => KEYRING_AI_ANTHROPIC,
        "gemini" => KEYRING_AI_GEMINI,
        _ => return Ok(()),
    };
    set_keyring_secret(&app, key_name, next_value)?;
    Ok(())
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
        if name == DATA_FILE_NAME || name == legacy_name {
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

#[tauri::command]
fn get_sync_path(app: tauri::AppHandle) -> Result<String, String> {
    let config = read_config(&app);
    let path = resolve_sync_dir(&app, config.sync_path).or_else(|_| resolve_sync_dir(&app, None))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn set_sync_path(app: tauri::AppHandle, sync_path: String) -> Result<serde_json::Value, String> {
    let config_path = get_config_path(&app);
    let sanitized_path = resolve_sync_dir(&app, Some(sync_path))?;

    let mut config = read_config(&app);
    config.sync_path = Some(sanitized_path.to_string_lossy().to_string());
    write_config_files(&config_path, &get_secrets_path(&app), &config)?;
    
    Ok(serde_json::json!({
        "success": true,
        "path": config.sync_path
    }))
}

fn normalize_backend(value: &str) -> Option<&str> {
    match value {
        "file" | "webdav" | "cloud" => Some(value),
        _ => None,
    }
}

#[tauri::command]
fn get_sync_backend(app: tauri::AppHandle) -> Result<String, String> {
    let config = read_config(&app);
    let raw = config.sync_backend.unwrap_or_else(|| "file".to_string());
    Ok(normalize_backend(raw.trim()).unwrap_or("file").to_string())
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
fn get_webdav_config(app: tauri::AppHandle) -> Result<Value, String> {
    let mut config = read_config(&app);
    let mut password = get_keyring_secret(&app, KEYRING_WEB_DAV_PASSWORD)?;
    if password.is_none() {
        if let Some(legacy) = config.webdav_password.clone() {
            set_keyring_secret(&app, KEYRING_WEB_DAV_PASSWORD, Some(legacy.clone()))?;
            config.webdav_password = None;
            write_config_files(&get_config_path(&app), &get_secrets_path(&app), &config)?;
            password = Some(legacy);
        }
    }
    Ok(serde_json::json!({
        "url": config.webdav_url.unwrap_or_default(),
        "username": config.webdav_username.unwrap_or_default(),
        "password": password.unwrap_or_default()
    }))
}

#[tauri::command]
fn set_webdav_config(app: tauri::AppHandle, url: String, username: String, password: String) -> Result<bool, String> {
    let url = url.trim().to_string();
    let config_path = get_config_path(&app);
    let mut config = read_config(&app);

    if url.is_empty() {
        config.webdav_url = None;
        config.webdav_username = None;
        config.webdav_password = None;
        set_keyring_secret(&app, KEYRING_WEB_DAV_PASSWORD, None)?;
    } else {
        config.webdav_url = Some(url);
        config.webdav_username = Some(username.trim().to_string());
        config.webdav_password = None;
        set_keyring_secret(&app, KEYRING_WEB_DAV_PASSWORD, Some(password))?;
    }

    write_config_files(&config_path, &get_secrets_path(&app), &config)?;
    Ok(true)
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
fn get_external_calendars(app: tauri::AppHandle) -> Result<Vec<ExternalCalendarSubscription>, String> {
    let config = read_config(&app);
    let raw = config.external_calendars.unwrap_or_else(|| "[]".to_string());
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
fn set_external_calendars(app: tauri::AppHandle, calendars: Vec<ExternalCalendarSubscription>) -> Result<bool, String> {
    let config_path = get_config_path(&app);
    let mut config = read_config(&app);
    let is_valid_calendar_url = |raw: &str| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return false;
        }
        trimmed.starts_with("https://") || trimmed.starts_with("http://") || trimmed.starts_with("webcal://")
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
fn read_sync_file(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let sync_path_str = get_sync_path(app)?;
    let sync_file = PathBuf::from(&sync_path_str).join(DATA_FILE_NAME);
    let backup_file = PathBuf::from(&sync_path_str).join(format!("{}.bak", DATA_FILE_NAME));
    
    if !sync_file.exists() {
        let legacy_sync_file = PathBuf::from(&sync_path_str).join(format!("{}-sync.json", APP_NAME));
        if legacy_sync_file.exists() {
            let content = fs::read_to_string(&legacy_sync_file).map_err(|e| e.to_string())?;
            return parse_json_relaxed(&content)
                .map(normalize_sync_value)
                .map_err(|e| e.to_string());
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
    let sync_file = PathBuf::from(&sync_path_str).join(DATA_FILE_NAME);
    let backup_file = PathBuf::from(&sync_path_str).join(format!("{}.bak", DATA_FILE_NAME));
    let tmp_file = PathBuf::from(&sync_path_str).join(format!("{}.tmp", DATA_FILE_NAME));

    if let Some(parent) = sync_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Best-effort backup for recovery.
    if sync_file.exists() {
        let _ = fs::copy(&sync_file, &backup_file);
    }

    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;

    // Atomic-ish write: write to tmp then rename over the target.
    {
        let mut file = File::create(&tmp_file).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }

    if cfg!(windows) && sync_file.exists() {
        // Windows doesn't allow renaming over an existing file.
        fs::remove_file(&sync_file).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_file, &sync_file).map_err(|e| e.to_string())?;
    
    Ok(true)
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
    let start = sanitized
        .find(|c| c == '{' || c == '[')
        .unwrap_or(0);
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
        match fs::read_to_string(path) {
            Ok(content) => match parse_json_relaxed(&content) {
                Ok(value) => return Ok(normalize_sync_value(value)),
                Err(e) => last_err = Some(e.to_string()),
            },
            Err(e) => last_err = Some(e.to_string()),
        }

        // Small backoff to allow other writers (Syncthing) to finish replacing the file.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(QuickAddPending(AtomicBool::new(false)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if cfg!(target_os = "windows") {
                    return;
                }
                api.prevent_close();
                let _ = window.set_skip_taskbar(true);
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // Ensure data file exists on startup
            ensure_data_file(&app.handle()).ok();
            if let Some(window) = app.get_webview_window("main") {
                if cfg!(target_os = "linux") && is_niri_session() {
                    let _ = window.set_decorations(false);
                }
            }

            // Build system tray with Quick Add entry.
            let handle = app.handle();
            let quick_add_item = MenuItem::with_id(handle, "quick_add", "Quick Add", true, None::<&str>)?;
            let show_item = MenuItem::with_id(handle, "show", "Show Mindwtr", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(handle, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(handle, &[&quick_add_item, &show_item, &quit_item])?;

            let tray_icon = Image::from_bytes(include_bytes!("../icons/tray.png"))
                .unwrap_or_else(|_| handle.default_window_icon().unwrap().clone());

            TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
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
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button, button_state, .. } = event {
                        if button == MouseButton::Left && button_state == MouseButtonState::Up {
                            show_main(tray.app_handle());
                        }
                    }
                })
                .build(handle)?;

            // Global hotkey for Quick Add.
            handle
                .global_shortcut()
                .on_shortcut("Alt+Shift+A", move |app, _shortcut, _event| {
                    show_main_and_emit(app);
                })?;
            
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data,
            save_data,
            query_tasks,
            search_fts,
            get_data_path_cmd,
            get_db_path_cmd,
            get_config_path_cmd,
            get_ai_key,
            set_ai_key,
            get_sync_path,
            set_sync_path,
            get_sync_backend,
            set_sync_backend,
            get_webdav_config,
            set_webdav_config,
            get_cloud_config,
            set_cloud_config,
            get_external_calendars,
            set_external_calendars,
            read_sync_file,
            write_sync_file,
            get_linux_distro,
            log_ai_debug,
            append_log_line,
            clear_log_file,
            consume_quick_add_pending
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
    app.state::<QuickAddPending>().0.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("quick-add", ());
    } else {
        let _ = app.emit("quick-add", ());
    }
}
