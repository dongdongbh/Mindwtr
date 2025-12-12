use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// App name used for config directories and files
const APP_NAME: &str = "mindwtr";

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppConfig {
    data_file_path: Option<String>,
    sync_path: Option<String>,
}

fn get_config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .expect("failed to get app config dir")
        .join("config.json")
}

fn get_data_path(app: &tauri::AppHandle) -> PathBuf {
    let config_path = get_config_path(app);
    if let Ok(content) = fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
            if let Some(path) = config.data_file_path {
                return PathBuf::from(path);
            }
        }
    }
    // Default data path: app_data_dir/data.json
    app.path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join("data.json")
}

fn ensure_data_file(app: &tauri::AppHandle) -> Result<(), String> {
    let data_path = get_data_path(app);
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if !data_path.exists() {
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

#[tauri::command]
fn get_data(app: tauri::AppHandle) -> Result<Value, String> {
    let data_path = get_data_path(&app);
    let content = fs::read_to_string(&data_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_data(app: tauri::AppHandle, data: Value) -> Result<bool, String> {
    let data_path = get_data_path(&app);
    fs::write(&data_path, serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn get_data_path_cmd(app: tauri::AppHandle) -> String {
    get_data_path(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn get_sync_path(app: tauri::AppHandle) -> Result<String, String> {
    let config_path = get_config_path(&app);
    if let Ok(content) = fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
            if let Some(path) = config.sync_path {
                return Ok(path);
            }
        }
    }
    // Default sync path: ~/Sync/{APP_NAME}
    // We try to use a safe home dir, falling back to error if not found
    let home = app.path().home_dir().map_err(|_| "Could not determine home directory for default sync path".to_string())?;
    
    Ok(home.join("Sync")
        .join(APP_NAME)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn set_sync_path(app: tauri::AppHandle, sync_path: String) -> Result<serde_json::Value, String> {
    let config_path = get_config_path(&app);
    
    // Load existing config or create new
    let mut config: AppConfig = if let Ok(content) = fs::read_to_string(&config_path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        AppConfig::default()
    };
    
    config.sync_path = Some(sync_path.clone());
    
    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    
    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| e.to_string())?;
    
    Ok(serde_json::json!({
        "success": true,
        "path": sync_path
    }))
}


#[tauri::command]
fn read_sync_file(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let sync_path_str = get_sync_path(app)?;
    let sync_file = PathBuf::from(&sync_path_str).join(format!("{}-sync.json", APP_NAME));
    
    if !sync_file.exists() {
        // Return empty app data structure if file doesn't exist
        return Ok(serde_json::json!({
            "tasks": [],
            "projects": [],
            "settings": {}
        }));
    }

    let content = fs::read_to_string(&sync_file).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}


#[tauri::command]
fn write_sync_file(app: tauri::AppHandle, data: Value) -> Result<bool, String> {
    let sync_path_str = get_sync_path(app)?;
    let sync_file = PathBuf::from(&sync_path_str).join(format!("{}-sync.json", APP_NAME));

    if let Some(parent) = sync_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(&sync_file, serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Ensure data file exists on startup
            ensure_data_file(&app.handle()).ok();
            
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
            get_data_path_cmd,
            get_sync_path,
            set_sync_path,
            read_sync_file,
            write_sync_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
