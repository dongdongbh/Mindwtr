use crate::*;

const PORTABLE_MARKER_FILE_NAME: &str = "portable.txt";
const PORTABLE_PROFILE_DIR_NAME: &str = "profile";
const PORTABLE_CONFIG_DIR_NAME: &str = "config";
const PORTABLE_DATA_DIR_NAME: &str = "data";

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

pub(crate) fn get_config_dir(app: &tauri::AppHandle) -> PathBuf {
    if let StorageMode::Portable { profile_root } = detect_storage_mode() {
        return profile_root.join(PORTABLE_CONFIG_DIR_NAME);
    }
    app.path()
        .resolve(APP_NAME, BaseDirectory::Config)
        .unwrap_or_else(|_| {
            // Fallback: use a sensible default under the user's home directory.
            let home = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
            home.join(APP_NAME)
        })
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

pub(crate) fn open_sqlite(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = get_db_path(app);
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(SQLITE_SCHEMA)
        .map_err(|e| e.to_string())?;
    ensure_column(&conn, "tasks", "energyLevel", "TEXT")?;
    ensure_column(&conn, "tasks", "assignedTo", "TEXT")?;
    ensure_tasks_purged_at_column(&conn)?;
    ensure_tasks_order_column(&conn)?;
    ensure_tasks_area_column(&conn)?;
    ensure_tasks_section_column(&conn)?;
    ensure_tasks_organization_indexes(&conn)?;
    ensure_projects_order_column(&conn)?;
    ensure_projects_due_date_column(&conn)?;
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

fn data_json_backup_path(data_path: &Path) -> PathBuf {
    data_path.with_extension("json.bak")
}

fn data_json_tmp_path(data_path: &Path) -> PathBuf {
    data_path.with_extension("json.tmp")
}

fn cleanup_stale_data_json_backup(data_path: &Path) -> Result<(), String> {
    if !cfg!(windows) {
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

fn write_data_json_file(data_path: &Path, data: &Value) -> Result<(), String> {
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    cleanup_stale_data_json_backup(data_path)?;
    let backup_path = data_json_backup_path(data_path);
    let tmp_path = data_json_tmp_path(data_path);
    let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    {
        let mut file = File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }

    if cfg!(windows) && data_path.exists() {
        fs::rename(data_path, &backup_path).map_err(|e| e.to_string())?;
        match fs::rename(&tmp_path, data_path) {
            Ok(()) => {
                let _ = fs::remove_file(&backup_path);
                return Ok(());
            }
            Err(rename_err) => {
                let restore_err = fs::rename(&backup_path, data_path).err();
                let _ = fs::remove_file(&tmp_path);
                return match restore_err {
                    Some(error) => Err(format!(
                        "Failed to replace data file: {rename_err}; original data kept at {} but restore also failed: {error}",
                        backup_path.display()
                    )),
                    None => Err(format!("Failed to replace data file: {rename_err}")),
                };
            }
        }
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
            "INSERT OR REPLACE INTO tasks (id, title, status, priority, energyLevel, assignedTo, taskMode, startTime, dueDate, recurrence, pushCount, tags, contexts, checklist, description, attachments, location, projectId, sectionId, areaId, orderNum, isFocusedToday, timeEstimate, reviewAt, completedAt, rev, revBy, createdAt, updatedAt, deletedAt, purgedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31)",
            params![
                task.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("title").and_then(|v| v.as_str()).unwrap_or_default(),
                task.get("status").and_then(|v| v.as_str()).unwrap_or("inbox"),
                task.get("priority").and_then(|v| v.as_str()),
                task.get("energyLevel").and_then(|v| v.as_str()),
                task.get("assignedTo").and_then(|v| v.as_str()),
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
            "INSERT OR REPLACE INTO projects (id, title, status, color, orderNum, tagIds, isSequential, isFocused, supportNotes, attachments, dueDate, reviewAt, areaId, areaTitle, rev, revBy, createdAt, updatedAt, deletedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
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
                project.get("dueDate").and_then(|v| v.as_str()),
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

pub(crate) fn ensure_data_file(app: &tauri::AppHandle) -> Result<(), String> {
    bootstrap_storage_layout(app)
}

#[tauri::command]
pub(crate) async fn get_data(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_data_file(&app)?;
        let data_path = get_data_path(&app);
        let backup_path = data_json_backup_path(&data_path);
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
pub(crate) async fn read_data_json(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_path = get_data_path(&app);
        cleanup_stale_data_json_backup(&data_path)?;
        read_json_with_retries(&data_path, 2).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn save_data(app: tauri::AppHandle, data: Value) -> Result<bool, String> {
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
pub(crate) fn create_data_snapshot(app: tauri::AppHandle) -> Result<String, String> {
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

#[tauri::command]
pub(crate) fn restore_data_snapshot(
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
pub(crate) fn query_tasks(
    app: tauri::AppHandle,
    options: TaskQueryOptions,
) -> Result<Vec<Value>, String> {
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
pub(crate) fn search_fts(app: tauri::AppHandle, query: String) -> Result<Value, String> {
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
pub(crate) fn get_data_path_cmd(app: tauri::AppHandle) -> String {
    get_data_path(&app).to_string_lossy().to_string()
}

#[tauri::command]
pub(crate) fn get_db_path_cmd(app: tauri::AppHandle) -> String {
    get_db_path(&app).to_string_lossy().to_string()
}

#[tauri::command]
pub(crate) fn get_config_path_cmd(app: tauri::AppHandle) -> String {
    get_config_path(&app).to_string_lossy().to_string()
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

    #[test]
    fn detect_storage_mode_returns_standard_without_marker() {
        let exe_dir = std::env::temp_dir().join("mindwtr-portable-mode-without-marker");

        let mode = detect_storage_mode_from_exe_dir(Some(&exe_dir));

        assert_eq!(mode, StorageMode::Standard);
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
        assert!(index_names.iter().any(|name| name == "idx_projects_dueDate"));
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
        assert!(index_names.iter().any(|name| name == "idx_tasks_energyLevel"));
        assert!(index_names.iter().any(|name| name == "idx_tasks_assignedTo"));
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

pub(crate) fn read_json_with_retries(path: &Path, attempts: usize) -> Result<Value, String> {
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
