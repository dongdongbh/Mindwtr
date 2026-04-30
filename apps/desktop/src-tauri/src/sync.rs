use crate::*;

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

#[tauri::command]
pub(crate) fn get_sync_path(app: tauri::AppHandle) -> Result<String, String> {
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

    let mut config = read_config(&app);
    config.sync_path = Some(sanitized_path.to_string_lossy().to_string());
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
            .map_err(|e| format!("WebDAV request failed: {e}"))?;
        Ok(response.status())
    })
}

fn is_webdav_mkcol_conflict_error(error: &str) -> bool {
    error.starts_with("WebDAV MKCOL failed (409")
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
pub(crate) async fn webdav_get_json(app: tauri::AppHandle) -> Result<Value, String> {
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
    let send_put = || {
        client
            .put(url.clone())
            .basic_auth(&username, Some(&password))
            .header("Content-Type", "application/json")
            .body(payload.clone())
            .send()
            .map_err(|e| format!("WebDAV request failed: {e}"))
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
        return Err(format!("WebDAV error: {}", response.status()));
    }
    Ok(true)
}

#[tauri::command]
pub(crate) async fn webdav_put_json(app: tauri::AppHandle, data: Value) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || webdav_put_json_blocking(&app, &data))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

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
}

#[tauri::command]
pub(crate) fn get_dropbox_redirect_uri() -> String {
    dropbox_redirect_uri()
}

#[tauri::command]
pub(crate) fn is_dropbox_connected(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<bool, String> {
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
pub(crate) async fn connect_dropbox(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<bool, String> {
    let oauth_result =
        tauri::async_runtime::spawn_blocking(move || run_dropbox_oauth(&app, &client_id))
            .await
            .map_err(|error| format!("Dropbox OAuth task failed: {error}"))?;
    oauth_result?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn get_dropbox_access_token(
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
pub(crate) async fn disconnect_dropbox(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<bool, String> {
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

fn acquire_sync_lock(sync_dir: &Path) -> Result<PathBuf, String> {
    let lock_path = sync_dir.join(".mindwtr.lock");
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
pub(crate) fn read_sync_file(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let sync_path_str = get_sync_path(app)?;
    if sync_path_str.trim().is_empty() {
        return Err("Sync path is not configured".to_string());
    }
    let sync_dir = PathBuf::from(&sync_path_str);
    let sync_file = sync_dir.join(DATA_FILE_NAME);
    let backup_file = sync_dir.join(format!("{}.bak", DATA_FILE_NAME));
    let legacy_sync_file = PathBuf::from(&sync_path_str).join(format!("{}-sync.json", APP_NAME));

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
            return Some(read_json_with_retries(&legacy_sync_file, 1));
        }
        if let Some(seed_file) = find_seed_backup_file(&sync_dir) {
            return Some(read_json_with_retries(&seed_file, 1));
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
pub(crate) fn write_sync_file(app: tauri::AppHandle, data: Value) -> Result<bool, String> {
    let sync_path_str = get_sync_path(app)?;
    if sync_path_str.trim().is_empty() {
        return Err("Sync path is not configured".to_string());
    }
    let sync_dir = PathBuf::from(&sync_path_str);
    let sync_file = sync_dir.join(DATA_FILE_NAME);
    let backup_file = sync_dir.join(format!("{}.bak", DATA_FILE_NAME));
    let tmp_file = sync_dir.join(format!("{}.tmp", DATA_FILE_NAME));

    if is_icloud_evicted(&sync_file) {
        log::warn!(
            "Sync target is iCloud-evicted; writing directly to avoid corrupting placeholder."
        );
    }

    if let Some(parent) = sync_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let lock = acquire_sync_lock(&sync_dir);
    let lock_path = match &lock {
        Ok(path) => Some(path.clone()),
        Err(msg) => {
            log::warn!("Sync lock unavailable, proceeding without lock: {msg}");
            None
        }
    };

    let result = (|| -> Result<bool, String> {
        if sync_file.exists() {
            let _ = fs::copy(&sync_file, &backup_file);
        }

        let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;

        {
            let mut file = File::create(&tmp_file).map_err(|e| e.to_string())?;
            file.write_all(content.as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }

        if cfg!(windows) && sync_file.exists() {
            fs::remove_file(&sync_file).map_err(|e| e.to_string())?;
        }

        match fs::rename(&tmp_file, &sync_file) {
            Ok(()) => Ok(true),
            Err(rename_err) => {
                log::warn!(
                    "Atomic rename failed ({}), falling back to direct write",
                    rename_err
                );
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

    if let Some(ref lp) = lock_path {
        release_sync_lock(lp);
    }

    result
}
