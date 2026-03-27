use crate::*;

pub(crate) fn parse_toml_string_value(raw: &str) -> Option<String> {
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

fn serialize_toml_string_value(value: &str) -> String {
    // Use TOML basic strings with minimal escaping.
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

pub(crate) fn read_config_toml(path: &Path) -> AppConfigToml {
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

pub(crate) fn read_config(app: &tauri::AppHandle) -> AppConfigToml {
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

pub(crate) fn write_config_files(
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

pub(crate) fn get_keyring_secret(
    app: &tauri::AppHandle,
    key: &str,
) -> Result<Option<String>, String> {
    let entry = keyring_entry(app, key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn set_keyring_secret(
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

#[tauri::command]
pub(crate) fn get_ai_key(app: tauri::AppHandle, provider: String) -> Option<String> {
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
pub(crate) fn set_ai_key(
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
pub(crate) fn get_sync_backend(app: tauri::AppHandle) -> Result<String, String> {
    let config = read_config(&app);
    let raw = config.sync_backend.unwrap_or_else(|| "off".to_string());
    Ok(normalize_backend(raw.trim()).unwrap_or("off").to_string())
}

#[tauri::command]
pub(crate) fn set_sync_backend(app: tauri::AppHandle, backend: String) -> Result<bool, String> {
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
pub(crate) fn get_obsidian_config(app: tauri::AppHandle) -> Result<Value, String> {
    let config = read_config(&app);
    serde_json::to_value(read_obsidian_config_payload(&config)).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn set_obsidian_config(app: tauri::AppHandle, config: Value) -> Result<Value, String> {
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
pub(crate) fn check_obsidian_vault_marker(vault_path: String) -> Result<bool, String> {
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
pub(crate) fn get_webdav_config(app: tauri::AppHandle) -> Result<Value, String> {
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
pub(crate) fn set_webdav_config(
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

#[tauri::command]
pub(crate) fn get_webdav_password(app: tauri::AppHandle) -> Result<String, String> {
    let config = read_config(&app);
    let password = match get_keyring_secret(&app, KEYRING_WEB_DAV_PASSWORD) {
        Ok(value) => value,
        Err(_) => None,
    }
    .or(config.webdav_password);
    Ok(password.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn get_cloud_config(app: tauri::AppHandle) -> Result<Value, String> {
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
pub(crate) fn set_cloud_config(
    app: tauri::AppHandle,
    url: String,
    token: String,
) -> Result<bool, String> {
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
pub(crate) fn get_external_calendars(
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
pub(crate) fn set_external_calendars(
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
