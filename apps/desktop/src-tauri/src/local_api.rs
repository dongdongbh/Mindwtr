use crate::storage::{
    ensure_data_file, load_data_snapshot, mutate_project_rows_with_retries,
    mutate_task_rows_with_retries, ProjectMutationReadScope, ProjectMutationRows,
    TaskMutationReadScope, PROJECT_MUTATION_NEXT_ORDER_KEY, TASK_MUTATION_FOCUSED_COUNT_KEY,
    TASK_MUTATION_PROJECT_NEXT_ORDERS_KEY,
};
use crate::{
    get_config_path, get_secrets_path, lock_config_read_modify_write, read_config,
    write_config_files, AppConfigToml,
};
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use time::format_description::well_known::Rfc3339;
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime};

const LOCAL_API_HOST: &str = "127.0.0.1";
pub(crate) const DEFAULT_LOCAL_API_PORT: u16 = 3456;
const MIN_LOCAL_API_PORT: u16 = 1024;
const MAX_LOCAL_API_PORT: u16 = u16::MAX;
const REQUEST_HEADER_LIMIT_BYTES: usize = 16 * 1024;
const REQUEST_BODY_LIMIT_BYTES: usize = 1_000_000;
// Generous for one desktop user's local integrations (a few concurrent
// MCP/automation clients), small enough that an unbounded slow-drip flood
// can't pin the whole thread pool (R-04).
const MAX_LOCAL_API_CONNECTIONS: usize = 32;
// Bounds total per-request wall time across every read, not just a single
// read() syscall the way set_read_timeout does - closes the slow-drip gap
// where a peer sends a few bytes just under that timeout, forever (R-04).
const REQUEST_DEADLINE: Duration = Duration::from_secs(10);
const LOCAL_API_TOKEN_BYTES: usize = 32;
const LOCAL_API_REV_BY: &str = "desktop-local-api";
const MAX_SYNC_REVISION: i64 = 2_147_483_647;
const MAX_TASK_TITLE_LENGTH: usize = 500;
const MAX_TASK_TOKEN_LENGTH: usize = MAX_TASK_TITLE_LENGTH;
const DEFAULT_PROJECT_COLOR: &str = "#94a3b8";
const RECURRENCE_REQUIRES_APP: &str = "recurrence_requires_app";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalApiServerStatus {
    enabled: bool,
    running: bool,
    port: u16,
    url: Option<String>,
    token: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct LocalApiConfig {
    enabled: bool,
    port: u16,
    token: Option<String>,
}

impl Default for LocalApiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_LOCAL_API_PORT,
            token: None,
        }
    }
}

pub(crate) struct LocalApiHandle {
    pub(crate) port: u16,
    shutdown: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl LocalApiHandle {
    #[cfg(test)]
    pub(crate) fn test_access(&self, allow_write: bool) -> LocalApiAccess {
        LocalApiAccess {
            allow_write,
            shutdown: self.shutdown.clone(),
        }
    }

    pub(crate) fn is_running(&self) -> bool {
        !self.shutdown.load(Ordering::SeqCst)
            && self.join.as_ref().is_some_and(|join| !join.is_finished())
    }
}

impl Drop for LocalApiHandle {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(join) = self.join.take() {
            // The accept loop is nonblocking; a rejected peer's response has a
            // five-second write timeout. Never let optional-server cleanup
            // prevent the desktop from exiting even if the loop panics/stalls.
            let deadline = Instant::now() + Duration::from_secs(6);
            while !join.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            if join.is_finished() {
                let _ = join.join();
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct LocalApiAccess {
    pub(crate) allow_write: bool,
    pub(crate) shutdown: Arc<AtomicBool>,
}

impl LocalApiAccess {
    pub(crate) fn ensure_active(&self) -> Result<(), String> {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err("Local API server is stopped".to_string());
        }
        Ok(())
    }

    pub(crate) fn ensure_write(&self) -> Result<(), String> {
        self.ensure_active()?;
        if !self.allow_write {
            return Err("Local API is read-only".to_string());
        }
        Ok(())
    }

    fn lock_write<'a>(
        &self,
        write_lock: &'a Mutex<()>,
    ) -> Result<std::sync::MutexGuard<'a, ()>, String> {
        let guard = lock_recovering(write_lock);
        // A request may have queued before stop/rotation. Re-check after it
        // acquires the shared mutation lock, immediately before storage.
        self.ensure_write()?;
        Ok(guard)
    }
}

#[derive(Default)]
struct LocalApiRuntime {
    handle: Option<LocalApiHandle>,
    last_error: Option<String>,
}

#[derive(Default)]
pub(crate) struct LocalApiServerState {
    inner: Mutex<LocalApiRuntime>,
    write_lock: Arc<Mutex<()>>,
}

/// Poison-recovering lock. A panic in one request thread must not permanently 500 every
/// future write while reads keep working: the write lock is a `Mutex<()>` (no state a panic
/// could half-mutate) and the runtime holds two `Option`s that are only ever replaced
/// wholesale. Same shape as `config.rs`'s `lock_dropbox_credential_state`.
fn lock_recovering<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug)]
pub(crate) struct ApiRequest {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) query: HashMap<String, String>,
    pub(crate) headers: HashMap<String, String>,
    pub(crate) body: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct ApiResponse {
    pub(crate) status: u16,
    pub(crate) body: Value,
}

impl ApiResponse {
    pub(crate) fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }

    pub(crate) fn error(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            body: json!({ "error": message.into() }),
        }
    }
}

pub(crate) fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub(crate) fn generate_uuid_v4() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

fn generate_local_api_token() -> String {
    let mut bytes = [0_u8; LOCAL_API_TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn normalize_local_api_port(port: Option<u16>) -> Result<u16, String> {
    let port = port.unwrap_or(DEFAULT_LOCAL_API_PORT);
    if !(MIN_LOCAL_API_PORT..=MAX_LOCAL_API_PORT).contains(&port) {
        return Err(format!(
            "Local API port must be between {} and {}.",
            MIN_LOCAL_API_PORT, MAX_LOCAL_API_PORT
        ));
    }
    Ok(port)
}

fn parse_bool_setting(value: Option<&String>) -> bool {
    value
        .map(|raw| raw.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn normalize_local_api_token(value: Option<&String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}

fn read_local_api_config(app: &tauri::AppHandle) -> LocalApiConfig {
    let config = read_config(app);
    let port = config
        .local_api_port
        .as_deref()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .and_then(|value| normalize_local_api_port(Some(value)).ok())
        .unwrap_or(DEFAULT_LOCAL_API_PORT);
    LocalApiConfig {
        enabled: parse_bool_setting(config.local_api_enabled.as_ref()),
        port,
        token: normalize_local_api_token(config.local_api_token.as_ref()),
    }
}

// Sole chokepoint for local-API config writes (ensure_local_api_token and
// set_local_api_server_config both route through here) — one held lock
// across the whole read+mutate+write closes the race now that callers run
// off the main thread (B2): two concurrent writers here (or in
// clear_sync_path/set_desktop_rendering_config, which share the lock) could
// otherwise each read the same base config and the second write clobbers the
// first's unrelated field changes.
fn write_local_api_config(app: &tauri::AppHandle, next: LocalApiConfig) -> Result<(), String> {
    let _config_guard = lock_config_read_modify_write()?;
    let mut config: AppConfigToml = read_config(app);
    config.local_api_enabled = Some(if next.enabled { "true" } else { "false" }.to_string());
    config.local_api_port = Some(next.port.to_string());
    config.local_api_token = next.token;
    write_config_files(&get_config_path(app), &get_secrets_path(app), &config)
}

fn ensure_local_api_token(
    app: &tauri::AppHandle,
    mut config: LocalApiConfig,
    required: bool,
) -> Result<LocalApiConfig, String> {
    if required && config.token.is_none() {
        config.token = Some(generate_local_api_token());
        write_local_api_config(app, config.clone())?;
    }
    Ok(config)
}

fn status_from_runtime(config: LocalApiConfig, runtime: &LocalApiRuntime) -> LocalApiServerStatus {
    let running_port = runtime.handle.as_ref().map(|handle| handle.port);
    let port = running_port.unwrap_or(config.port);
    LocalApiServerStatus {
        enabled: config.enabled,
        running: running_port.is_some(),
        port,
        url: running_port.map(|value| format!("http://{}:{}", LOCAL_API_HOST, value)),
        token: config.enabled.then(|| config.token.clone()).flatten(),
        error: runtime.last_error.clone(),
    }
}

fn stop_runtime(runtime: &mut LocalApiRuntime) {
    drop(runtime.handle.take());
}

pub(crate) fn start_mcp_listener(
    app: tauri::AppHandle,
    state: &LocalApiServerState,
    port: u16,
    token: String,
    permissions: crate::mcp_server::McpPermissions,
) -> Result<LocalApiHandle, String> {
    start_runtime_with_access(
        app,
        port,
        token,
        state.write_lock.clone(),
        permissions.any_write(),
        Some(permissions),
    )
}

fn start_runtime(
    app: tauri::AppHandle,
    port: u16,
    token: String,
    write_lock: Arc<Mutex<()>>,
) -> Result<LocalApiHandle, String> {
    start_runtime_with_access(app, port, token, write_lock, true, None)
}

fn start_runtime_with_access(
    app: tauri::AppHandle,
    port: u16,
    token: String,
    write_lock: Arc<Mutex<()>>,
    allow_write: bool,
    mcp_permissions: Option<crate::mcp_server::McpPermissions>,
) -> Result<LocalApiHandle, String> {
    ensure_data_file(&app)?;
    start_http_listener(port, allow_write, move |access, port, request| {
        if let Some(permissions) = mcp_permissions {
            crate::mcp_server::handle_mcp_request(
                &token,
                access,
                permissions,
                port,
                request,
                |operation| execute_operation(&app, &write_lock, access, operation),
            )
        } else {
            handle_api_request(&app, &token, &write_lock, access, request)
        }
    })
}

pub(crate) fn start_http_listener(
    port: u16,
    allow_write: bool,
    handler: impl Fn(&LocalApiAccess, u16, ApiRequest) -> ApiResponse + Send + Sync + 'static,
) -> Result<LocalApiHandle, String> {
    let listener = TcpListener::bind((LOCAL_API_HOST, port)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AddrInUse {
            "port_in_use".to_string()
        } else {
            "start_failed".to_string()
        }
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to configure local API server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|_| "Failed to locate local API listener".to_string())?
        .port();

    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = shutdown.clone();
    let access = LocalApiAccess {
        allow_write,
        shutdown: shutdown.clone(),
    };
    let handler = Arc::new(handler);
    let active_connections = Arc::new(AtomicUsize::new(0));
    let join = thread::spawn(move || {
        while !thread_shutdown.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let Some(stream) = accept_or_reject(stream, &active_connections) else {
                        continue;
                    };
                    let handler = handler.clone();
                    let active_connections = active_connections.clone();
                    let access = access.clone();
                    thread::spawn(move || {
                        let _slot_guard = ConnectionSlotGuard(active_connections);
                        handle_connection(&access, port, &*handler, stream);
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    log::warn!("Local HTTP listener accept failed");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });

    Ok(LocalApiHandle {
        port,
        shutdown,
        join: Some(join),
    })
}

pub(crate) fn start_configured_local_api_server(
    app: &tauri::AppHandle,
    state: &LocalApiServerState,
) {
    let config = read_local_api_config(app);
    if !config.enabled {
        return;
    }
    let config = match ensure_local_api_token(app, config, true) {
        Ok(config) => config,
        Err(error) => {
            log::warn!("Failed to prepare local API token: {error}");
            return;
        }
    };

    let mut runtime = lock_recovering(&state.inner);
    if runtime.handle.is_some() {
        return;
    }
    let Some(token) = config.token.clone() else {
        runtime.last_error = Some("Local API token is not configured".to_string());
        return;
    };
    match start_runtime(app.clone(), config.port, token, state.write_lock.clone()) {
        Ok(handle) => {
            runtime.handle = Some(handle);
            runtime.last_error = None;
        }
        Err(error) => {
            log::warn!("{error}");
            runtime.last_error = Some(error);
        }
    }
}

#[tauri::command(async)]
pub(crate) fn get_local_api_server_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalApiServerState>,
) -> Result<LocalApiServerStatus, String> {
    let config = read_local_api_config(&app);
    let config = ensure_local_api_token(&app, config.clone(), config.enabled)?;
    let runtime = lock_recovering(&state.inner);
    Ok(status_from_runtime(config, &runtime))
}

#[tauri::command(async)]
pub(crate) fn set_local_api_server_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalApiServerState>,
    enabled: bool,
    port: Option<u16>,
) -> Result<LocalApiServerStatus, String> {
    let port = normalize_local_api_port(port)?;
    let current_config = ensure_local_api_token(&app, read_local_api_config(&app), enabled)?;
    let token = current_config.token.clone();
    let mut runtime = lock_recovering(&state.inner);

    if enabled {
        let token_for_runtime = token
            .clone()
            .ok_or_else(|| "Local API token is not configured".to_string())?;
        if runtime.handle.as_ref().map(|handle| handle.port) != Some(port) {
            stop_runtime(&mut runtime);
            match start_runtime(
                app.clone(),
                port,
                token_for_runtime.clone(),
                state.write_lock.clone(),
            ) {
                Ok(handle) => {
                    runtime.handle = Some(handle);
                    runtime.last_error = None;
                }
                Err(error) => {
                    runtime.last_error = Some(error.clone());
                    let _ = write_local_api_config(
                        &app,
                        LocalApiConfig {
                            enabled: false,
                            port,
                            token: token.clone(),
                        },
                    );
                    return Ok(status_from_runtime(
                        LocalApiConfig {
                            enabled: false,
                            port,
                            token,
                        },
                        &runtime,
                    ));
                }
            }
        }
    } else {
        stop_runtime(&mut runtime);
        runtime.last_error = None;
    }

    let config = LocalApiConfig {
        enabled,
        port,
        token,
    };
    write_local_api_config(&app, config.clone())?;
    Ok(status_from_runtime(config, &runtime))
}

// Decrements the shared counter on drop, so a panic inside handle_connection
// (unwinding through this guard) can't leak a permit the way a plain
// fetch_sub call at the end of the function would (R-04).
struct ConnectionSlotGuard(Arc<AtomicUsize>);

impl Drop for ConnectionSlotGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

// Lifted out of the accept loop so the cap can be exercised with a real
// loopback socket in tests, without a tauri::AppHandle (R-04, same pattern as
// apply_task_action). The accept loop is the only incrementer (this function
// only ever runs on that one thread), so a plain load-then-add has no TOCTOU
// window that could let the count exceed the cap - a concurrent decrement
// from a finishing handler can only make a borderline request wait, never
// let the count overshoot.
fn accept_or_reject(
    mut stream: TcpStream,
    active_connections: &Arc<AtomicUsize>,
) -> Option<TcpStream> {
    if active_connections.load(Ordering::SeqCst) >= MAX_LOCAL_API_CONNECTIONS {
        let _ = write_response(
            &mut stream,
            ApiResponse::error(503, "Local API server is busy"),
        );
        return None;
    }
    active_connections.fetch_add(1, Ordering::SeqCst);
    Some(stream)
}

fn handle_connection(
    access: &LocalApiAccess,
    port: u16,
    handler: &impl Fn(&LocalApiAccess, u16, ApiRequest) -> ApiResponse,
    mut stream: TcpStream,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let deadline = Instant::now() + REQUEST_DEADLINE;
    let response = match read_request(&mut stream, deadline) {
        Ok(Some(request)) => handler(access, port, request),
        Ok(None) => return,
        Err(_) => ApiResponse::error(400, "Invalid HTTP request"),
    };
    let _ = write_response(&mut stream, response);
}

// Generic over Read (R-05) so tests can drive it with an in-memory reader
// instead of a real socket - TcpStream: Read, so the one call site in
// handle_connection is unchanged.
fn read_request(stream: &mut impl Read, deadline: Instant) -> Result<Option<ApiRequest>, String> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut temp = [0_u8; 1024];
    let header_end = loop {
        if Instant::now() > deadline {
            return Err("Request timed out".to_string());
        }
        let read = stream.read(&mut temp).map_err(|e| e.to_string())?;
        if read == 0 {
            if buffer.is_empty() {
                return Ok(None);
            }
            return Err("Incomplete HTTP request".to_string());
        }
        buffer.extend_from_slice(&temp[..read]);
        if buffer.len() > REQUEST_HEADER_LIMIT_BYTES + REQUEST_BODY_LIMIT_BYTES {
            return Err("Request too large".to_string());
        }
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        if buffer.len() > REQUEST_HEADER_LIMIT_BYTES {
            return Err("Request headers too large".to_string());
        }
    };

    if header_end > REQUEST_HEADER_LIMIT_BYTES {
        return Err("Request headers too large".into());
    }
    let header_bytes = &buffer[..header_end];
    let header_text = std::str::from_utf8(header_bytes)
        .map_err(|_| "Invalid HTTP header encoding".to_string())?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "Missing HTTP request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "Missing HTTP method".to_string())?
        .to_ascii_uppercase();
    let target = request_parts
        .next()
        .ok_or_else(|| "Missing HTTP target".to_string())?;
    if !matches!(request_parts.next(), Some("HTTP/1.0" | "HTTP/1.1"))
        || request_parts.next().is_some()
        || !target.starts_with('/')
    {
        return Err("Invalid HTTP request line".into());
    }
    let (path, query) = parse_request_target(target);

    let mut content_length = 0_usize;
    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err("Invalid HTTP header".into());
        };
        let header_name = name.trim().to_ascii_lowercase();
        let header_value = value.trim().to_string();
        if header_name == "content-length" {
            content_length = value
                .trim()
                .parse::<usize>()
                .map_err(|_| "Invalid Content-Length".to_string())?;
        }
        if header_name == "transfer-encoding" || headers.insert(header_name, header_value).is_some()
        {
            return Err("Unsupported duplicate or transfer-encoded header".into());
        }
    }
    if content_length > REQUEST_BODY_LIMIT_BYTES {
        return Err("Request body too large".to_string());
    }

    let body_start = header_end + 4;
    while buffer.len().saturating_sub(body_start) < content_length {
        if Instant::now() > deadline {
            return Err("Request timed out".to_string());
        }
        let read = stream.read(&mut temp).map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("Incomplete HTTP request body".to_string());
        }
        buffer.extend_from_slice(&temp[..read]);
    }
    let body = buffer[body_start..body_start + content_length].to_vec();

    Ok(Some(ApiRequest {
        method,
        path,
        query,
        headers,
        body,
    }))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_request_target(target: &str) -> (String, HashMap<String, String>) {
    let (path_raw, query_raw) = target.split_once('?').unwrap_or((target, ""));
    let path = percent_decode(path_raw).unwrap_or_else(|| path_raw.to_string());
    let mut query = HashMap::new();
    for pair in query_raw.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode(key).unwrap_or_else(|| key.to_string());
        let value = percent_decode(value).unwrap_or_else(|| value.to_string());
        query.insert(key, value);
    }
    (path, query)
}

fn write_response(stream: &mut TcpStream, response: ApiResponse) -> Result<(), String> {
    // Without this, write_all against a client that never reads its socket
    // buffer (or a peer that vanished) blocks forever once the buffer fills.
    // The shared write path for both handle_connection's real response and
    // accept_or_reject's 503 rejection - that second one runs synchronously
    // on the accept loop's own thread, so an unbounded block there would
    // stop the server from accepting any connection at all, not just pin one
    // of the capped slots (I3).
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let raw = http_response(&response);
    stream.write_all(raw.as_bytes()).map_err(|e| e.to_string())
}

fn http_response(response: &ApiResponse) -> String {
    let status_text = match response.status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        406 => "Not Acceptable",
        415 => "Unsupported Media Type",
        503 => "Service Unavailable",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let body = if response.status == 202 {
        String::new()
    } else {
        serde_json::to_string_pretty(&response.body).unwrap_or_else(|_| "{}".to_string())
    };
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response.status,
        status_text,
        body.len(),
        body,
    )
}

fn handle_api_request(
    app: &tauri::AppHandle,
    token: &str,
    write_lock: &Arc<Mutex<()>>,
    access: &LocalApiAccess,
    request: ApiRequest,
) -> ApiResponse {
    handle_api_operation(token, access, request, |operation| {
        execute_operation(app, write_lock, access, operation)
    })
}

fn handle_api_operation(
    token: &str,
    access: &LocalApiAccess,
    request: ApiRequest,
    execute: impl FnOnce(LocalOperation) -> Result<Value, String>,
) -> ApiResponse {
    if let Some(response) = authorize_api_request(&request, token, access) {
        return response;
    }

    match route_api_operation(request, execute) {
        Ok(response) => response,
        Err(error) => api_error_response(error),
    }
}

fn authorize_api_request(
    request: &ApiRequest,
    token: &str,
    access: &LocalApiAccess,
) -> Option<ApiResponse> {
    if let Err(error) = access.ensure_active() {
        return Some(api_error_response(error));
    }
    if request.method == "OPTIONS" {
        return Some(ApiResponse::ok(json!({ "ok": true })));
    }
    if !is_request_authorized(&request, token) {
        return Some(ApiResponse::error(401, "Unauthorized"));
    }
    if request.method != "GET" {
        if let Err(error) = access.ensure_write() {
            return Some(api_error_response(error));
        }
    }
    None
}

// Constant-time over fixed-length digests rather than the raw header value:
// loopback-only with a random token keeps the real-world severity low, but a
// bare `==` still leaks the token length and a byte-by-byte early-out, so hash
// both sides first (like apps/cloud/src/server-auth.ts's timingSafeEqual over
// SHA-256 digests) and compare with no short-circuit.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |diff, (x, y)| diff | (x ^ y))
        == 0
}

pub(crate) fn is_request_authorized(request: &ApiRequest, token: &str) -> bool {
    let expected_digest = Sha256::digest(token.as_bytes());
    let actual_digest = request.headers.get("authorization").and_then(|header| {
        let mut parts = header.split_whitespace();
        if !parts.next()?.eq_ignore_ascii_case("Bearer") {
            return None;
        }
        let credential = parts.next()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Sha256::digest(credential.as_bytes()))
    });
    match actual_digest {
        Some(actual_digest) => constant_time_eq(&actual_digest, &expected_digest),
        None => false,
    }
}

pub(crate) fn api_error_response(error: String) -> ApiResponse {
    if error == RECURRENCE_REQUIRES_APP {
        return recurrence_completion_refusal_response();
    }
    if matches!(
        error.as_str(),
        "Local API is read-only" | "Local API server is stopped"
    ) {
        return ApiResponse::error(403, error);
    }
    if matches!(
        error.as_str(),
        "Task not found" | "Project not found" | "Area not found"
    ) {
        return ApiResponse::error(404, error);
    }
    if error.starts_with("Task status conflict:")
        || error.starts_with("Project update conflict:")
        || error.starts_with("Area update conflict:")
        || error.starts_with("Focus limit of ")
    {
        return ApiResponse::error(409, error);
    }
    if error.starts_with("Invalid ")
        || error.starts_with("Unsupported ")
        || error.starts_with("Task title")
        || error.starts_with("Project title")
        || error.starts_with("Request ")
    {
        return ApiResponse::error(400, error);
    }
    ApiResponse::error(500, error)
}

/// Validated transport adapters invoke these operations directly. Both endpoints
/// retain the same storage transactions, mutation lock, and durable responses.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LocalOperation {
    Health,
    ListTasks(HashMap<String, String>),
    QueryTasks(Map<String, Value>),
    ListProjects,
    GetProject(String),
    CreateProject(Map<String, Value>),
    PatchProject {
        id: String,
        body: Map<String, Value>,
    },
    ProjectLifecycle {
        id: String,
        restore: bool,
    },
    ListAreas,
    GetArea(String),
    PatchArea {
        id: String,
        body: Map<String, Value>,
    },
    Search(String),
    GetTask(String),
    CreateTask(Map<String, Value>),
    PatchTask {
        id: String,
        body: Map<String, Value>,
    },
    DeleteTask(String),
    TaskAction {
        id: String,
        action: String,
    },
}

impl LocalOperation {
    pub(crate) fn writes(&self) -> bool {
        matches!(
            self,
            Self::CreateProject(_)
                | Self::PatchProject { .. }
                | Self::PatchArea { .. }
                | Self::ProjectLifecycle { .. }
                | Self::CreateTask(_)
                | Self::PatchTask { .. }
                | Self::DeleteTask(_)
                | Self::TaskAction { .. }
        )
    }
}

pub(crate) fn operation_from_api_request(
    request: &ApiRequest,
) -> Result<Option<LocalOperation>, String> {
    let segments = path_segments(&request.path);
    let id = || segments[1].clone();
    let body = || parse_body_object(&request.body);
    let operation = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => LocalOperation::Health,
        ("GET", "/tasks") => LocalOperation::ListTasks(request.query.clone()),
        ("GET", "/projects") => LocalOperation::ListProjects,
        ("GET", "/areas" | "/v1/areas") => LocalOperation::ListAreas,
        ("GET", "/search") => {
            LocalOperation::Search(request.query.get("query").cloned().unwrap_or_default())
        }
        ("POST", "/tasks") => LocalOperation::CreateTask(body()?),
        ("POST", "/projects") => LocalOperation::CreateProject(body()?),
        (method, _) if segments.len() == 2 && segments[0] == "areas" => match method {
            "GET" => LocalOperation::GetArea(id()),
            "PATCH" => LocalOperation::PatchArea {
                id: id(),
                body: body()?,
            },
            _ => return Ok(None),
        },
        (method, _) if segments.len() == 2 && segments[0] == "tasks" => match method {
            "GET" => LocalOperation::GetTask(id()),
            "PATCH" => LocalOperation::PatchTask {
                id: id(),
                body: body()?,
            },
            "DELETE" => LocalOperation::DeleteTask(id()),
            _ => return Ok(None),
        },
        (method, _) if segments.len() == 2 && segments[0] == "projects" => match method {
            "GET" => LocalOperation::GetProject(id()),
            "PATCH" => LocalOperation::PatchProject {
                id: id(),
                body: body()?,
            },
            "DELETE" => LocalOperation::ProjectLifecycle {
                id: id(),
                restore: false,
            },
            _ => return Ok(None),
        },
        ("POST", _)
            if segments.len() == 3
                && segments[0] == "tasks"
                && matches!(segments[2].as_str(), "complete" | "archive" | "restore") =>
        {
            LocalOperation::TaskAction {
                id: id(),
                action: segments[2].clone(),
            }
        }
        ("POST", _)
            if segments.len() == 3 && segments[0] == "projects" && segments[2] == "restore" =>
        {
            LocalOperation::ProjectLifecycle {
                id: id(),
                restore: true,
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(operation))
}

fn route_api_operation(
    request: ApiRequest,
    execute: impl FnOnce(LocalOperation) -> Result<Value, String>,
) -> Result<ApiResponse, String> {
    let Some(operation) = operation_from_api_request(&request)? else {
        return Ok(ApiResponse::error(404, "Not found"));
    };
    let created = matches!(
        operation,
        LocalOperation::CreateTask(_) | LocalOperation::CreateProject(_)
    );
    let deleted = matches!(
        operation,
        LocalOperation::DeleteTask(_) | LocalOperation::ProjectLifecycle { restore: false, .. }
    );
    let body = execute(operation)?;
    Ok(ApiResponse {
        status: if created { 201 } else { 200 },
        body: if deleted { json!({ "ok": true }) } else { body },
    })
}

pub(crate) fn execute_operation(
    app: &tauri::AppHandle,
    write_lock: &Arc<Mutex<()>>,
    access: &LocalApiAccess,
    operation: LocalOperation,
) -> Result<Value, String> {
    access.ensure_active()?;
    if operation.writes() {
        access.ensure_write()?;
    }
    match operation {
        LocalOperation::Health => {
            return Ok(json!({ "ok": true }));
        }
        LocalOperation::ListTasks(query) => {
            let data = load_data_snapshot(app)?;
            let tasks = filter_tasks(array_items(&data, "tasks"), &query)?;
            return Ok(json!({ "tasks": tasks }));
        }
        LocalOperation::ListProjects => {
            let data = load_data_snapshot(app)?;
            let projects = array_items(&data, "projects")
                .into_iter()
                .filter(|project| !has_string_field(project, "deletedAt"))
                .collect::<Vec<_>>();
            return Ok(json!({ "projects": projects }));
        }
        LocalOperation::CreateProject(body) => {
            let _guard = access.lock_write(write_lock)?;
            let target_area_id = body
                .get("props")
                .and_then(Value::as_object)
                .and_then(|props| props.get("areaId"))
                .and_then(Value::as_str);
            let scope = ProjectMutationReadScope::create(target_area_id);
            let (project_id, persisted) = mutate_project_rows_with_retries(app, scope, |data| {
                let project = create_project_from_body(&body, data)?;
                let project_id = project
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Project id is required".to_string())?
                    .to_string();
                let project = Value::Object(project);
                ensure_array_mut(data, "projects")?.push(project.clone());
                Ok((
                    project_id,
                    ProjectMutationRows {
                        projects: vec![project],
                        ..ProjectMutationRows::default()
                    },
                ))
            })?;
            log::info!(
            "Desktop Local API project write persisted extra.releaseCheck=v1.3.1/local-api-project-write"
        );
            return Ok(json!({ "project": persisted_project(&persisted, &project_id)? }));
        }
        LocalOperation::GetProject(id) => {
            let data = load_data_snapshot(app)?;
            let project =
                find_project(&data, &id).ok_or_else(|| "Project not found".to_string())?;
            return Ok(json!({ "project": project }));
        }
        LocalOperation::ProjectLifecycle {
            id,
            restore: restore_project,
        } => {
            let _guard = access.lock_write(write_lock)?;
            let scope = ProjectMutationReadScope::lifecycle(&id);
            let (changed, persisted) = mutate_project_rows_with_retries(app, scope, |data| {
                let rows = apply_project_delete_or_restore(data, &id, restore_project)?;
                Ok((!rows.projects.is_empty(), rows))
            })?;
            let operation = if restore_project { "restore" } else { "delete" };
            let outcome = if changed { "persisted" } else { "unchanged" };
            log::info!(
            "Desktop Local API project lifecycle completed extra.releaseCheck=v1.3.1/local-api-project-lifecycle operation={operation} outcome={outcome}"
        );
            return Ok(json!({ "project": persisted_project(&persisted, &id)? }));
        }
        LocalOperation::PatchProject { id, body } => {
            let _guard = access.lock_write(write_lock)?;
            let scope = ProjectMutationReadScope::patch(
                &id,
                body.get("areaId").and_then(Value::as_str),
                body.contains_key("areaId"),
                body.contains_key("status"),
            );
            let (_, persisted) = mutate_project_rows_with_retries(app, scope, |data| {
                let (project, tasks, sections) = patch_project_in_data(data, &id, &body)?;
                Ok((
                    (),
                    ProjectMutationRows {
                        projects: vec![project],
                        tasks,
                        sections,
                        ..ProjectMutationRows::default()
                    },
                ))
            })?;
            log::info!(
            "Desktop Local API project write persisted extra.releaseCheck=v1.3.1/local-api-project-write"
        );
            return Ok(json!({ "project": persisted_project(&persisted, &id)? }));
        }
        LocalOperation::ListAreas => {
            let data = load_data_snapshot(app)?;
            let areas = array_items(&data, "areas")
                .into_iter()
                .filter(|area| !has_string_field(area, "deletedAt"))
                .collect::<Vec<_>>();
            return Ok(json!({ "areas": areas }));
        }
        LocalOperation::GetArea(id) => {
            let data = load_data_snapshot(app)?;
            let area = live_project_area(&data, &id).ok_or("Area not found")?;
            return Ok(json!({ "area": area }));
        }
        LocalOperation::PatchArea { id, body } => {
            let _guard = access.lock_write(write_lock)?;
            let (_, persisted) = mutate_project_rows_with_retries(
                app,
                ProjectMutationReadScope::area_update(&id),
                |data| Ok(((), patch_area_in_data(data, &id, &body, &now_iso())?)),
            )?;
            log::info!(
                "Desktop Local API area update persisted extra.releaseCheck=v1.3.5/local-api-area-update outcome=persisted"
            );
            let area =
                live_project_area(&persisted, &id).ok_or("Area not found after persistence")?;
            return Ok(json!({ "area": area }));
        }
        LocalOperation::Search(query) => {
            let data = load_data_snapshot(app)?;
            return Ok(search_data(&data, &query));
        }
        LocalOperation::GetTask(id) => {
            let data = load_data_snapshot(app)?;
            let task = find_task(&data, &id).ok_or_else(|| "Task not found".to_string())?;
            return Ok(json!({ "task": task }));
        }
        LocalOperation::CreateTask(body) => {
            let _guard = access.lock_write(write_lock)?;
            let props = body.get("props").and_then(Value::as_object);
            let scope = TaskMutationReadScope::create(
                props
                    .and_then(|props| props.get("projectId"))
                    .and_then(Value::as_str),
                props
                    .and_then(|props| props.get("sectionId"))
                    .and_then(Value::as_str),
                props
                    .and_then(|props| props.get("areaId"))
                    .and_then(Value::as_str),
                props
                    .and_then(|props| props.get("isFocusedToday"))
                    .and_then(Value::as_bool)
                    == Some(true),
            );
            let operation = LocalOperation::CreateTask(body);
            let (task_id, persisted) = mutate_task_rows_with_retries(app, scope, |data| {
                mutate_task_operation(data, &operation)
            })?;
            let task = persisted_task(&persisted, &task_id)?;
            let now = OffsetDateTime::now_utc();
            if task.get("isFocusedToday").and_then(Value::as_bool) == Some(true)
                && task.as_object().is_some_and(|task| {
                    local_api_task_is_future_start(task, now, &crate::local_query::local_wall)
                })
            {
                let count =
                    local_api_focused_task_count(&persisted, now, &crate::local_query::local_wall);
                log::info!(
                "Desktop Local API scheduled Focus queued extra.releaseCheck=v1.3.3/local-api-scheduled-focus operation=create outcome=queued count={count}"
            );
            }
            return Ok(json!({ "task": task }));
        }
        LocalOperation::PatchTask { id, body } => {
            let _guard = access.lock_write(write_lock)?;
            let is_triage = body.contains_key("status");
            let scope = task_patch_read_scope(&id, &body);
            let operation = LocalOperation::PatchTask {
                id: id.clone(),
                body,
            };
            let (_, persisted) = mutate_task_rows_with_retries(app, scope, |data| {
                mutate_task_operation(data, &operation)
            })?;
            if is_triage {
                log::info!(
                "Desktop Local API task triage persisted extra.releaseCheck=v1.3.1/local-api-task-triage"
            );
            }
            return Ok(json!({ "task": persisted_task(&persisted, &id)? }));
        }
        LocalOperation::DeleteTask(id) => {
            let _guard = access.lock_write(write_lock)?;
            let scope = TaskMutationReadScope::existing(&id, false);
            let operation = LocalOperation::DeleteTask(id.clone());
            let (_, persisted) = mutate_task_rows_with_retries(app, scope, |data| {
                mutate_task_operation(data, &operation)
            })?;
            return Ok(json!({ "task": persisted_task(&persisted, &id)? }));
        }
        LocalOperation::TaskAction { id, action } => {
            let action = action.as_str();
            if !matches!(action, "complete" | "archive" | "restore") {
                return Err("Unsupported task action".into());
            }
            let _guard = access.lock_write(write_lock)?;
            let scope = TaskMutationReadScope::existing(&id, action == "restore");
            let operation = LocalOperation::TaskAction {
                id: id.clone(),
                action: action.into(),
            };
            let mutation = mutate_task_rows_with_retries(app, scope, |data| {
                mutate_task_operation(data, &operation)
            });
            let (_, persisted) = match mutation {
                Ok(result) => result,
                Err(error) if error == RECURRENCE_REQUIRES_APP => {
                    return Err(RECURRENCE_REQUIRES_APP.to_string());
                }
                Err(error) => return Err(error),
            };
            return Ok(json!({ "task": persisted_task(&persisted, &id)? }));
        }
        LocalOperation::QueryTasks(input) => {
            let data = load_data_snapshot(app)?;
            Ok(json!({ "tasks": crate::local_query::query_tasks(&data, &input)? }))
        }
    }
}

fn mutate_task_operation(
    data: &mut Value,
    operation: &LocalOperation,
) -> Result<(String, Vec<Value>), String> {
    match operation {
        LocalOperation::CreateTask(body) => {
            let task = create_task_from_body(&body, &device_id_from_data(data), data)?;
            let task_id = task
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Task id is required".to_string())?
                .to_string();
            let task = Value::Object(task);
            ensure_array_mut(data, "tasks")?.push(task.clone());
            Ok((task_id, vec![task]))
        }
        LocalOperation::PatchTask { id, body } => {
            let task = patch_task_in_data(data, &id, &body)?;
            Ok((id.clone(), vec![task]))
        }
        LocalOperation::DeleteTask(id) => {
            let device_id = device_id_from_data(data);
            let task = update_task_in_data(data, &id, |task| {
                let now = now_iso();
                task.insert("deletedAt".to_string(), Value::String(now.clone()));
                task.insert("updatedAt".to_string(), Value::String(now));
                bump_task_revision(task, &device_id);
                Ok(())
            })?;
            Ok((id.clone(), vec![task]))
        }
        LocalOperation::TaskAction { id, action } => {
            let action = action.as_str();
            let now = now_iso();
            if action == "complete" && recurrence_completion_refusal(data, &id, &now).is_some() {
                if find_task(data, &id).is_some_and(|task| {
                    task.as_object()
                        .is_some_and(|task| recurrence_start_needs_catchup(task, &now))
                }) {
                    log::info!("Desktop Local API recurrence requires app extra.releaseCheck=v1.3.5/start-only-recurrence outcome=requires-app");
                }
                return Err(RECURRENCE_REQUIRES_APP.to_string());
            }
            let device_id = device_id_from_data(data);
            let live_containers = if action == "restore" {
                LiveContainers::from_data(data)
            } else {
                LiveContainers::default()
            };
            let mut recurring_follow_up: Option<Map<String, Value>> = None;
            let task = update_task_in_data(data, &id, |task| {
                let previous_status = task
                    .get("status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("inbox")
                    .to_string();
                recurring_follow_up = apply_task_action(
                    task,
                    action,
                    &previous_status,
                    &now,
                    &device_id,
                    &live_containers,
                )?;
                Ok(())
            })?;
            let mut changed_tasks = vec![task];
            if let Some(next_task) = recurring_follow_up {
                let next_task = Value::Object(next_task);
                ensure_array_mut(data, "tasks")?.push(next_task.clone());
                changed_tasks.push(next_task);
            }
            Ok((id.clone(), changed_tasks))
        }
        _ => Err("Unsupported task mutation".into()),
    }
}

fn path_segments(path: &str) -> Vec<String> {
    path.trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| percent_decode(segment).unwrap_or_else(|| segment.to_string()))
        .collect()
}

fn array_items(data: &Value, key: &str) -> Vec<Value> {
    data.get(key)
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
}

fn ensure_array_mut<'a>(data: &'a mut Value, key: &str) -> Result<&'a mut Vec<Value>, String> {
    let object = data
        .as_object_mut()
        .ok_or_else(|| "Local data snapshot is invalid".to_string())?;
    let entry = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !entry.is_array() {
        *entry = Value::Array(Vec::new());
    }
    entry
        .as_array_mut()
        .ok_or_else(|| "Local data snapshot is invalid".to_string())
}

fn has_string_field(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(|field| field.as_str())
        .is_some_and(|field| !field.trim().is_empty())
}

fn parse_boolean_query_param(
    query: &HashMap<String, String>,
    name: &str,
) -> Result<Option<bool>, String> {
    let Some(raw) = query.get(name) else {
        return Ok(None);
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" => Ok(Some(true)),
        "0" | "false" => Ok(Some(false)),
        _ => Err(format!("Invalid {name}")),
    }
}

fn task_is_focused_today(task: &Value) -> bool {
    match task.get("isFocusedToday") {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|value| value != 0.0),
        _ => false,
    }
}

fn filter_tasks(tasks: Vec<Value>, query: &HashMap<String, String>) -> Result<Vec<Value>, String> {
    let include_all = query.get("all").map(|value| value == "1").unwrap_or(false);
    let include_deleted = query
        .get("deleted")
        .map(|value| value == "1")
        .unwrap_or(false);
    let status = query
        .get("status")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    if let Some(status) = status {
        validate_task_status(status)?;
    }
    let text_query = query
        .get("query")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let is_focused_today = parse_boolean_query_param(query, "isFocusedToday")?;

    let filtered = tasks
        .into_iter()
        .filter(|task| include_deleted || !has_string_field(task, "deletedAt"))
        .filter(|task| {
            if include_all {
                return true;
            }
            let status = task
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            status != "done" && status != "archived"
        })
        .filter(|task| {
            status
                .map(|target| task.get("status").and_then(|value| value.as_str()) == Some(target))
                .unwrap_or(true)
        })
        .filter(|task| {
            is_focused_today
                .map(|target| task_is_focused_today(task) == target)
                .unwrap_or(true)
        })
        .filter(|task| {
            text_query
                .as_ref()
                .map(|target| value_search_text(task).contains(target))
                .unwrap_or(true)
        })
        .collect();
    Ok(filtered)
}

fn search_data(data: &Value, query: &str) -> Value {
    let target = query.trim().to_ascii_lowercase();
    if target.is_empty() {
        return json!({ "tasks": [], "projects": [] });
    }
    let tasks = array_items(data, "tasks")
        .into_iter()
        .filter(|task| !has_string_field(task, "deletedAt"))
        .filter(|task| value_search_text(task).contains(&target))
        .collect::<Vec<_>>();
    let projects = array_items(data, "projects")
        .into_iter()
        .filter(|project| !has_string_field(project, "deletedAt"))
        .filter(|project| value_search_text(project).contains(&target))
        .collect::<Vec<_>>();
    json!({ "tasks": tasks, "projects": projects })
}

fn value_search_text(value: &Value) -> String {
    [
        "title",
        "description",
        "status",
        "tags",
        "contexts",
        "projectId",
        "areaId",
        "name",
        "supportNotes",
    ]
    .iter()
    .filter_map(|key| value.get(*key))
    .map(|field| {
        field
            .as_str()
            .map(|raw| raw.to_string())
            .unwrap_or_else(|| field.to_string())
    })
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase()
}

fn find_task(data: &Value, task_id: &str) -> Option<Value> {
    data.get("tasks")?
        .as_array()?
        .iter()
        .find(|task| task.get("id").and_then(|value| value.as_str()) == Some(task_id))
        .cloned()
}

fn persisted_task(data: &Value, task_id: &str) -> Result<Value, String> {
    find_task(data, task_id).ok_or_else(|| "Task not found after persistence".to_string())
}

fn find_project(data: &Value, project_id: &str) -> Option<Value> {
    data.get("projects")?
        .as_array()?
        .iter()
        .find(|project| project.get("id").and_then(Value::as_str) == Some(project_id))
        .cloned()
}

fn persisted_project(data: &Value, project_id: &str) -> Result<Value, String> {
    find_project(data, project_id).ok_or_else(|| "Project not found after persistence".to_string())
}

fn live_project_area<'a>(data: &'a Value, area_id: &str) -> Option<&'a Value> {
    data.get("areas")?.as_array()?.iter().find(|area| {
        area.get("id").and_then(Value::as_str) == Some(area_id)
            && !has_string_field(area, "deletedAt")
    })
}

fn trim_area_name(name: &str) -> &str {
    // Match JavaScript trim, including BOM and excluding NEXT LINE.
    name.trim_matches(|character| {
        matches!(character,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

fn patch_area_in_data(
    data: &mut Value,
    id: &str,
    patch: &Map<String, Value>,
    now: &str,
) -> Result<ProjectMutationRows, String> {
    let current = live_project_area(data, id).ok_or("Area not found")?.clone();
    if patch.is_empty() {
        return Err("Request patch must include at least one area field".to_string());
    }
    let mut sanitized = Map::new();
    for (field, value) in patch {
        let value = match field.as_str() {
            "name" => {
                let name = value
                    .as_str()
                    .map(trim_area_name)
                    .filter(|name| !name.is_empty())
                    .ok_or("Invalid area field: name")?;
                Value::String(name.to_string())
            }
            "color" | "icon" if value.is_null() || value.is_string() => value.clone(),
            "color" | "icon" => return Err(format!("Invalid area field: {field}")),
            "order" => {
                value
                    .as_f64()
                    .filter(|order| order.is_finite())
                    .ok_or("Invalid area field: order")?;
                value.clone()
            }
            _ => return Err(format!("Unsupported area field: {field}")),
        };
        sanitized.insert(field.clone(), value);
    }
    if let Some(name) = sanitized.get("name").and_then(Value::as_str) {
        let normalized = name.to_lowercase();
        if array_items(data, "areas").iter().any(|area| {
            area.get("id").and_then(Value::as_str) != Some(id)
                && !has_string_field(area, "deletedAt")
                && area
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| trim_area_name(name).to_lowercase() == normalized)
        }) {
            return Err("Area update conflict: another live area has this name".to_string());
        }
    }
    let name = sanitized
        .get("name")
        .or_else(|| current.get("name"))
        .and_then(Value::as_str)
        .ok_or("Invalid area name")?
        .to_string();
    let repaint = sanitized.contains_key("color");
    let repair_title = repaint
        || (sanitized.contains_key("name")
            && name != trim_area_name(current["name"].as_str().unwrap_or_default()));
    let color = sanitized
        .get("color")
        .and_then(Value::as_str)
        .unwrap_or("#94a3b8");
    let title = trim_area_name(&name);
    let target_title = (!title.is_empty()).then_some(title);
    let device_id = device_id_from_data(data);
    let mut projects = Vec::new();
    if repair_title {
        for project in ensure_array_mut(data, "projects")? {
            if project.get("areaId").and_then(Value::as_str) != Some(id) {
                continue;
            }
            let wants_color =
                repaint && project.get("color").and_then(Value::as_str) != Some(color);
            let wants_title = project.get("areaTitle").and_then(Value::as_str) != target_title;
            if !wants_color && !wants_title {
                continue;
            }
            let project = project.as_object_mut().ok_or("Invalid project")?;
            if wants_color {
                project.insert("color".to_string(), json!(color));
            }
            if wants_title {
                if title.is_empty() {
                    project.remove("areaTitle");
                } else {
                    project.insert("areaTitle".to_string(), json!(title));
                }
            }
            project.insert("updatedAt".to_string(), json!(now));
            bump_task_revision(project, &device_id);
            projects.push(Value::Object(project.clone()));
        }
    }
    let mut area = current.as_object().cloned().ok_or("Invalid area")?;
    for (field, value) in sanitized {
        if value.is_null() {
            area.remove(&field);
        } else {
            area.insert(field, value);
        }
    }
    area.insert("updatedAt".to_string(), json!(now));
    bump_task_revision(&mut area, &device_id);
    let area = Value::Object(area);
    for item in ensure_array_mut(data, "areas")? {
        if item.get("id").and_then(Value::as_str) == Some(id) {
            *item = area.clone();
        }
    }
    Ok(ProjectMutationRows {
        areas: vec![area],
        projects,
        ..ProjectMutationRows::default()
    })
}

pub(crate) fn sanitize_project_fields(
    fields: &Map<String, Value>,
    allow_title: bool,
) -> Result<Map<String, Value>, String> {
    if allow_title && fields.is_empty() {
        return Err("Request patch must include at least one project field".to_string());
    }
    let mut sanitized = Map::new();
    for (key, value) in fields {
        let normalized = match key.as_str() {
            "title" if allow_title => {
                let title = value
                    .as_str()
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .ok_or_else(|| "Invalid project field: title".to_string())?;
                if js_string_length(title) > MAX_TASK_TITLE_LENGTH {
                    return Err(format!(
                        "Project title too long (max {MAX_TASK_TITLE_LENGTH} characters)"
                    ));
                }
                Value::String(title.to_string())
            }
            "areaId" => {
                if value.is_null() {
                    Value::Null
                } else {
                    let area_id = value
                        .as_str()
                        .map(str::trim)
                        .filter(|area_id| !area_id.is_empty())
                        .ok_or_else(|| "Invalid project field: areaId".to_string())?;
                    Value::String(area_id.to_string())
                }
            }
            "color" => {
                let color = value
                    .as_str()
                    .filter(|color| !color.trim().is_empty())
                    .ok_or_else(|| "Invalid project field: color".to_string())?;
                Value::String(color.to_string())
            }
            "status" => {
                let status = value
                    .as_str()
                    .filter(|status| {
                        matches!(*status, "active" | "someday" | "waiting" | "archived")
                    })
                    .ok_or_else(|| "Invalid project field: status".to_string())?;
                Value::String(status.to_string())
            }
            "isSequential" => Value::Bool(
                value
                    .as_bool()
                    .ok_or_else(|| "Invalid project field: isSequential".to_string())?,
            ),
            "sequentialScope" => {
                let scope = value
                    .as_str()
                    .filter(|scope| matches!(*scope, "project" | "section"))
                    .ok_or_else(|| "Invalid project field: sequentialScope".to_string())?;
                Value::String(scope.to_string())
            }
            "order" => {
                let order = value
                    .as_f64()
                    .filter(|order| order.is_finite())
                    .and_then(serde_json::Number::from_f64)
                    .ok_or_else(|| "Invalid project field: order".to_string())?;
                Value::Number(order)
            }
            _ => return Err(format!("Unsupported project field: {key}")),
        };
        sanitized.insert(key.clone(), normalized);
    }
    Ok(sanitized)
}

fn create_project_from_body(
    body: &Map<String, Value>,
    data: &Value,
) -> Result<Map<String, Value>, String> {
    for key in body.keys() {
        if !matches!(key.as_str(), "title" | "props") {
            return Err(format!("Unsupported project field: {key}"));
        }
    }
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .ok_or_else(|| "Project title is required".to_string())?;
    if js_string_length(title) > MAX_TASK_TITLE_LENGTH {
        return Err(format!(
            "Project title too long (max {MAX_TASK_TITLE_LENGTH} characters)"
        ));
    }
    let empty_props = Map::new();
    let props = match body.get("props") {
        None => &empty_props,
        Some(Value::Object(props)) => props,
        Some(_) => return Err("Invalid project props".to_string()),
    };
    let props = sanitize_project_fields(props, false)?;
    let area_id = props.get("areaId").and_then(Value::as_str);
    let area = match area_id {
        Some(area_id) => Some(live_project_area(data, area_id).ok_or("Area not found")?),
        None => None,
    };
    let default_sequential = data
        .get("settings")
        .and_then(|settings| settings.get("gtd"))
        .and_then(|gtd| gtd.get("defaultProjectFlowMode"))
        .and_then(Value::as_str)
        == Some("sequential");
    let now = now_iso();
    let mut project = Map::new();
    project.insert("id".to_string(), Value::String(generate_uuid_v4()));
    project.insert("title".to_string(), Value::String(title.to_string()));
    project.insert(
        "status".to_string(),
        props
            .get("status")
            .cloned()
            .unwrap_or_else(|| Value::String("active".to_string())),
    );
    project.insert(
        "color".to_string(),
        props
            .get("color")
            .cloned()
            .unwrap_or_else(|| Value::String(DEFAULT_PROJECT_COLOR.to_string())),
    );
    project.insert(
        "order".to_string(),
        props
            .get("order")
            .cloned()
            .or_else(|| data.get(PROJECT_MUTATION_NEXT_ORDER_KEY).cloned())
            .unwrap_or_else(|| Value::Number(0.into())),
    );
    project.insert("tagIds".to_string(), Value::Array(Vec::new()));
    project.insert(
        "isSequential".to_string(),
        props
            .get("isSequential")
            .cloned()
            .unwrap_or(Value::Bool(default_sequential)),
    );
    project.insert("isFocused".to_string(), Value::Bool(false));
    if let Some(scope) = props.get("sequentialScope") {
        project.insert("sequentialScope".to_string(), scope.clone());
    }
    if let Some(area_id) = area_id {
        project.insert("areaId".to_string(), Value::String(area_id.to_string()));
    }
    if let Some(area_title) = area
        .and_then(|area| area.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        project.insert(
            "areaTitle".to_string(),
            Value::String(area_title.to_string()),
        );
    }
    project.insert("rev".to_string(), Value::Number(1.into()));
    project.insert(
        "revBy".to_string(),
        Value::String(device_id_from_data(data)),
    );
    project.insert("createdAt".to_string(), Value::String(now.clone()));
    if project.get("status").and_then(Value::as_str) == Some("archived") {
        project.insert("archivedAt".to_string(), Value::String(now.clone()));
    }
    project.insert("updatedAt".to_string(), Value::String(now));
    Ok(project)
}

fn valid_cancellation_timestamp(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|timestamp| {
        timestamp.as_bytes().get(10) == Some(&b'T')
            && OffsetDateTime::parse(timestamp, &Rfc3339).is_ok()
    })
}

fn is_non_terminal_task_status(status: &str) -> bool {
    matches!(
        status,
        "inbox" | "next" | "waiting" | "someday" | "reference"
    )
}

fn apply_project_archive_to_task(
    task: &mut Map<String, Value>,
    archived_at: &str,
    device_id: &str,
    cancellation_at: Option<&str>,
) {
    let previous_status = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("inbox")
        .to_string();
    task.insert(
        "statusBeforeProjectArchive".to_string(),
        Value::String(previous_status),
    );
    if let Some(completed_at) = task.get("completedAt").cloned() {
        task.insert("completedAtBeforeProjectArchive".to_string(), completed_at);
    } else {
        task.remove("completedAtBeforeProjectArchive");
    }
    if let Some(focused) = task.get("isFocusedToday").cloned() {
        task.insert("isFocusedTodayBeforeProjectArchive".to_string(), focused);
    } else {
        task.remove("isFocusedTodayBeforeProjectArchive");
    }
    task.insert(
        "projectArchivedAt".to_string(),
        Value::String(archived_at.to_string()),
    );
    task.insert(
        "archivedAt".to_string(),
        Value::String(archived_at.to_string()),
    );
    task.insert("isFocusedToday".to_string(), Value::Bool(false));
    task.remove("focusOrder");
    if let Some(cancelled_at) = cancellation_at {
        task.insert("status".to_string(), Value::String("archived".to_string()));
        task.insert(
            "cancelledAt".to_string(),
            Value::String(cancelled_at.to_string()),
        );
        task.remove("completedAt");
    } else {
        task.insert("status".to_string(), Value::String("done".to_string()));
        task.insert(
            "completedAt".to_string(),
            Value::String(archived_at.to_string()),
        );
        task.remove("cancelledAt");
    }
    task.insert(
        "updatedAt".to_string(),
        Value::String(archived_at.to_string()),
    );
    bump_task_revision(task, device_id);
}

fn restore_task_from_project_archive(
    task: &mut Map<String, Value>,
    restored_at: &str,
    device_id: &str,
) -> bool {
    let Some(previous_status) = task
        .get("statusBeforeProjectArchive")
        .and_then(Value::as_str)
        .filter(|status| is_non_terminal_task_status(status))
        .map(str::to_string)
    else {
        return false;
    };
    let Some(archived_at) = task
        .get("projectArchivedAt")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return false;
    };
    if has_non_empty_string(task, "deletedAt")
        || task.get("updatedAt").and_then(Value::as_str) != Some(archived_at.as_str())
    {
        return false;
    }
    let status = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("inbox");
    let completed_by_project = status == "done"
        && !valid_cancellation_timestamp(task.get("cancelledAt"))
        && task.get("completedAt").and_then(Value::as_str) == Some(archived_at.as_str());
    let cancelled_by_project = status == "archived"
        && valid_cancellation_timestamp(task.get("cancelledAt"))
        && !has_non_empty_string(task, "completedAt");
    if !completed_by_project && !cancelled_by_project {
        return false;
    }
    task.insert("status".to_string(), Value::String(previous_status));
    if let Some(completed_at) = task.get("completedAtBeforeProjectArchive").cloned() {
        task.insert("completedAt".to_string(), completed_at);
    } else {
        task.remove("completedAt");
    }
    task.remove("cancelledAt");
    let focused = task
        .get("isFocusedTodayBeforeProjectArchive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    task.insert("isFocusedToday".to_string(), Value::Bool(focused));
    task.remove("statusBeforeProjectArchive");
    task.remove("completedAtBeforeProjectArchive");
    task.remove("isFocusedTodayBeforeProjectArchive");
    task.remove("projectArchivedAt");
    task.remove("archivedAt");
    task.insert(
        "updatedAt".to_string(),
        Value::String(restored_at.to_string()),
    );
    bump_task_revision(task, device_id);
    true
}

fn apply_project_lifecycle_to_children(
    data: &mut Value,
    project_id: &str,
    previous_status: &str,
    next_status: &str,
    operation_at: &str,
    device_id: &str,
    cancellation_at: Option<&str>,
) -> Result<(Vec<Value>, Vec<Value>), String> {
    let entered_archive = previous_status != "archived" && next_status == "archived";
    let reactivated = previous_status == "archived" && next_status != "archived";
    if !entered_archive && !reactivated {
        return Ok((Vec::new(), Vec::new()));
    }

    let project_section_ids: HashSet<String> = data
        .get("sections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|section| section.get("projectId").and_then(Value::as_str) == Some(project_id))
        .filter_map(|section| {
            section
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let mut changed_tasks = Vec::new();
    for task in ensure_array_mut(data, "tasks")? {
        let Some(task_object) = task.as_object_mut() else {
            continue;
        };
        let task_project_id = task_object.get("projectId").and_then(Value::as_str);
        let section_owned = task_object
            .get("sectionId")
            .and_then(Value::as_str)
            .is_some_and(|section_id| project_section_ids.contains(section_id));
        let needs_owner_repair = task_project_id.map_or(true, str::is_empty) && section_owned;
        let belongs_to_project = task_project_id == Some(project_id) || needs_owner_repair;
        if !belongs_to_project {
            continue;
        }
        if has_non_empty_string(task_object, "deletedAt") {
            continue;
        }
        if entered_archive {
            if needs_owner_repair {
                task_object.insert(
                    "projectId".to_string(),
                    Value::String(project_id.to_string()),
                );
            }
            let status = task_object
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("inbox");
            if !matches!(status, "inbox" | "next" | "waiting" | "someday") {
                let needs_archive_stamp = matches!(status, "done" | "reference")
                    && !has_non_empty_string(task_object, "archivedAt");
                if needs_archive_stamp {
                    task_object.insert(
                        "archivedAt".to_string(),
                        Value::String(operation_at.to_string()),
                    );
                }
                if needs_archive_stamp || needs_owner_repair {
                    task_object.insert(
                        "updatedAt".to_string(),
                        Value::String(operation_at.to_string()),
                    );
                    bump_task_revision(task_object, device_id);
                    changed_tasks.push(Value::Object(task_object.clone()));
                }
                continue;
            }
            apply_project_archive_to_task(task_object, operation_at, device_id, cancellation_at);
            changed_tasks.push(Value::Object(task_object.clone()));
        } else {
            let mut changed =
                restore_task_from_project_archive(task_object, operation_at, device_id);
            if !changed
                && matches!(
                    task_object.get("status").and_then(Value::as_str),
                    Some("done" | "reference")
                )
                && has_non_empty_string(task_object, "archivedAt")
            {
                task_object.remove("archivedAt");
                task_object.insert(
                    "updatedAt".to_string(),
                    Value::String(operation_at.to_string()),
                );
                bump_task_revision(task_object, device_id);
                changed = true;
            }
            if needs_owner_repair {
                task_object.insert(
                    "projectId".to_string(),
                    Value::String(project_id.to_string()),
                );
                if !changed {
                    task_object.insert(
                        "updatedAt".to_string(),
                        Value::String(operation_at.to_string()),
                    );
                    bump_task_revision(task_object, device_id);
                }
                changed = true;
            }
            if changed {
                changed_tasks.push(Value::Object(task_object.clone()));
            }
        }
    }

    let mut changed_sections = Vec::new();
    for section in ensure_array_mut(data, "sections")? {
        let Some(section_object) = section.as_object_mut() else {
            continue;
        };
        if section_object.get("projectId").and_then(Value::as_str) != Some(project_id) {
            continue;
        }
        if entered_archive {
            if has_non_empty_string(section_object, "deletedAt") {
                continue;
            }
            section_object.remove("deletedAtBeforeProjectArchive");
            section_object.insert(
                "deletedAt".to_string(),
                Value::String(operation_at.to_string()),
            );
            section_object.insert(
                "projectArchivedAt".to_string(),
                Value::String(operation_at.to_string()),
            );
        } else {
            let Some(archived_at) = section_object
                .get("projectArchivedAt")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            let was_live = section_object
                .get("deletedAtBeforeProjectArchive")
                .map_or(true, Value::is_null);
            if !was_live
                || section_object.get("updatedAt").and_then(Value::as_str)
                    != Some(archived_at.as_str())
                || section_object.get("deletedAt").and_then(Value::as_str)
                    != Some(archived_at.as_str())
            {
                continue;
            }
            section_object.remove("deletedAt");
            section_object.remove("deletedAtBeforeProjectArchive");
            section_object.remove("projectArchivedAt");
        }
        section_object.insert(
            "updatedAt".to_string(),
            Value::String(operation_at.to_string()),
        );
        bump_task_revision(section_object, device_id);
        changed_sections.push(Value::Object(section_object.clone()));
    }
    Ok((changed_tasks, changed_sections))
}

pub(crate) fn patch_project_in_data(
    data: &mut Value,
    project_id: &str,
    patch: &Map<String, Value>,
) -> Result<(Value, Vec<Value>, Vec<Value>), String> {
    let current = find_project(data, project_id).ok_or_else(|| "Project not found".to_string())?;
    if has_string_field(&current, "purgedAt") {
        return Err("Project update conflict: purged project cannot be updated".to_string());
    }
    if has_string_field(&current, "deletedAt") {
        return Err(
            "Project update conflict: use POST /projects/:id/restore before updating it"
                .to_string(),
        );
    }
    let mut project = current
        .as_object()
        .cloned()
        .ok_or_else(|| "Project is invalid".to_string())?;
    let sanitized = sanitize_project_fields(patch, true)?;
    let previous_status = project
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active")
        .to_string();
    let next_status = sanitized
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(&previous_status)
        .to_string();
    let previous_area_id = project
        .get("areaId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let next_area_id = if sanitized.contains_key("areaId") {
        sanitized
            .get("areaId")
            .and_then(Value::as_str)
            .map(str::to_string)
    } else {
        previous_area_id.clone()
    };
    let area_title = if sanitized.contains_key("areaId") {
        match next_area_id.as_deref() {
            Some(area_id) => live_project_area(data, area_id)
                .ok_or("Area not found")?
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string),
            None => None,
        }
    } else {
        None
    };
    let area_changed = sanitized.contains_key("areaId") && next_area_id != previous_area_id;
    let now = now_iso();
    let device_id = device_id_from_data(data);

    for (key, value) in sanitized {
        if value.is_null() {
            project.remove(&key);
        } else {
            project.insert(key, value);
        }
    }
    if area_changed && !patch.contains_key("order") {
        let order = data
            .get(PROJECT_MUTATION_NEXT_ORDER_KEY)
            .cloned()
            .unwrap_or_else(|| Value::Number(0.into()));
        project.insert("order".to_string(), order);
    }
    if patch.contains_key("areaId") {
        if let Some(area_title) = area_title {
            project.insert("areaTitle".to_string(), Value::String(area_title));
        } else {
            project.remove("areaTitle");
        }
    }
    if next_status != previous_status && next_status != "active" {
        project.insert("isFocused".to_string(), Value::Bool(false));
    }
    let cancellation_at =
        if next_status == "archived" && valid_cancellation_timestamp(project.get("cancelledAt")) {
            project
                .get("cancelledAt")
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            project.remove("cancelledAt");
            None
        };
    if next_status == "archived" {
        project.insert("isFocused".to_string(), Value::Bool(false));
    }
    if previous_status != "archived" && next_status == "archived" {
        project.insert("archivedAt".to_string(), Value::String(now.clone()));
    } else if previous_status == "archived" && next_status != "archived" {
        project.remove("archivedAt");
    }
    let (changed_tasks, changed_sections) = apply_project_lifecycle_to_children(
        data,
        project_id,
        &previous_status,
        &next_status,
        &now,
        &device_id,
        cancellation_at.as_deref(),
    )?;
    project.insert("updatedAt".to_string(), Value::String(now));
    bump_task_revision(&mut project, &device_id);

    let projects = ensure_array_mut(data, "projects")?;
    let stored = projects
        .iter_mut()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(project_id))
        .ok_or_else(|| "Project not found".to_string())?;
    *stored = Value::Object(project.clone());
    Ok((Value::Object(project), changed_tasks, changed_sections))
}

/// Mirrors core project delete/restore: delete detaches live tasks instead of
/// deleting them; restore only revives children from the same legacy cascade.
/// Called on fresh transaction-scoped rows, never a stale whole-app snapshot.
pub(crate) fn apply_project_delete_or_restore(
    data: &mut Value,
    project_id: &str,
    restore: bool,
) -> Result<ProjectMutationRows, String> {
    let now = now_iso();
    let device_id = device_id_from_data(data);
    apply_project_delete_or_restore_at(data, project_id, restore, &now, &device_id)
}

/// The clock and device id are parameters so the shared core/Rust fixture
/// (`packages/core/src/recurrence-local-api-parity.fixtures.json`, kind
/// `project-action`) can pin both engines against the same frozen `now`, the
/// way `apply_task_action` already is.
fn apply_project_delete_or_restore_at(
    data: &mut Value,
    project_id: &str,
    restore: bool,
    now: &str,
    device_id: &str,
) -> Result<ProjectMutationRows, String> {
    let current = find_project(data, project_id).ok_or("Project not found")?;
    if has_string_field(&current, "purgedAt") {
        return Err("Project update conflict: purged project cannot be changed".to_string());
    }
    let deleted_at = current
        .get("deletedAt")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if restore != deleted_at.is_some() {
        return Ok(ProjectMutationRows::default());
    }
    let mut project = current.as_object().cloned().ok_or("Project is invalid")?;
    if restore {
        project.remove("deletedAt");
        project.remove("purgedAt");
        let area = project
            .get("areaId")
            .and_then(Value::as_str)
            .and_then(|id| live_project_area(data, id));
        if let Some(area) = area {
            if !has_string_field(&Value::Object(project.clone()), "areaTitle") {
                if let Some(name) = area.get("name") {
                    project.insert("areaTitle".to_string(), name.clone());
                }
            }
        } else {
            project.remove("areaId");
            project.remove("areaTitle");
        }
    } else {
        project.insert("deletedAt".to_string(), json!(now));
    }
    project.insert("updatedAt".to_string(), json!(now));
    bump_task_revision(&mut project, device_id);
    let mut changed = ProjectMutationRows::default();
    let mut section_ids = HashSet::new();
    let mut live_section_ids = HashSet::new();
    for section in ensure_array_mut(data, "sections")? {
        if section.get("projectId").and_then(Value::as_str) != Some(project_id) {
            continue;
        }
        if let Some(id) = section.get("id").and_then(Value::as_str) {
            section_ids.insert(id.to_string());
        }
        let matches_cascade =
            restore && section.get("deletedAt").and_then(Value::as_str) == deleted_at.as_deref();
        if !has_string_field(section, "purgedAt")
            && (matches_cascade || (!restore && !has_string_field(section, "deletedAt")))
        {
            if let Some(object) = section.as_object_mut() {
                if restore {
                    object.remove("deletedAt");
                } else {
                    object.insert("deletedAt".to_string(), json!(now));
                }
                object.insert("updatedAt".to_string(), json!(now));
                bump_task_revision(object, device_id);
                changed.sections.push(section.clone());
            }
        }
        if !has_string_field(section, "deletedAt") && !has_string_field(section, "purgedAt") {
            if let Some(id) = section.get("id").and_then(Value::as_str) {
                live_section_ids.insert(id.to_string());
            }
        }
    }
    for task in ensure_array_mut(data, "tasks")? {
        if has_string_field(task, "purgedAt") {
            continue;
        }
        let owns_project = task.get("projectId").and_then(Value::as_str) == Some(project_id);
        let owns_section = task
            .get("sectionId")
            .and_then(Value::as_str)
            .is_some_and(|id| section_ids.contains(id));
        let should_change = if restore {
            owns_project && task.get("deletedAt").and_then(Value::as_str) == deleted_at.as_deref()
        } else {
            !has_string_field(task, "deletedAt") && (owns_project || owns_section)
        };
        if !should_change {
            continue;
        }
        if let Some(object) = task.as_object_mut() {
            if restore {
                object.remove("deletedAt");
                if !object
                    .get("sectionId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| live_section_ids.contains(id))
                {
                    object.remove("sectionId");
                }
            } else {
                object.remove("projectId");
                object.remove("sectionId");
            }
            object.insert("updatedAt".to_string(), json!(now));
            bump_task_revision(object, device_id);
            changed.tasks.push(task.clone());
        }
    }
    let updated = Value::Object(project);
    let stored = ensure_array_mut(data, "projects")?
        .iter_mut()
        .find(|project| project.get("id").and_then(Value::as_str) == Some(project_id))
        .ok_or("Project not found")?;
    *stored = updated.clone();
    changed.projects.push(updated);
    Ok(changed)
}

/// Refuses `POST /tasks/{id}/complete` outright when the task's recurrence
/// carries selectors this engine cannot compute (byDay/byMonthDay/rrule —
/// see `recurrence_needs_core_engine`). A vanished recurring series is worse
/// than a rejected request: nothing is read here except to decide, and the
/// caller must not proceed to `update_task_in_data` when this returns `Some`,
/// so the task is left completely untouched on disk.
fn recurrence_completion_refusal(
    data: &Value,
    task_id: &str,
    completed_at: &str,
) -> Option<ApiResponse> {
    let task = find_task(data, task_id)?;
    let task_object = task.as_object()?;
    let previous_status = task_object
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("inbox");
    if !should_create_recurring_follow_up("complete", previous_status) {
        return None;
    }
    if recurrence_rule(task_object).is_none()
        || (!recurrence_needs_core_engine(task_object)
            && !recurrence_start_needs_catchup(task_object, completed_at))
    {
        return None;
    }
    Some(recurrence_completion_refusal_response())
}

fn recurrence_completion_refusal_response() -> ApiResponse {
    ApiResponse {
        status: 409,
        body: json!({
            "error": "This task's recurrence rule requires the app to complete it correctly.",
            "code": RECURRENCE_REQUIRES_APP,
        }),
    }
}

fn update_task_in_data<F>(data: &mut Value, task_id: &str, update: F) -> Result<Value, String>
where
    F: FnOnce(&mut Map<String, Value>) -> Result<(), String>,
{
    let tasks = ensure_array_mut(data, "tasks")?;
    let task = tasks
        .iter_mut()
        .find(|task| task.get("id").and_then(|value| value.as_str()) == Some(task_id))
        .ok_or_else(|| "Task not found".to_string())?;
    let task_object = task
        .as_object_mut()
        .ok_or_else(|| "Task is invalid".to_string())?;
    update(task_object)?;
    Ok(Value::Object(task_object.clone()))
}

/// Live (non-deleted, non-purged) project/section/area ids, snapshotted from
/// the data file before a restore mutates it. A section only counts as live
/// when its own owning project is also live, mirroring
/// `sanitizeRestoredTaskContainerReferences`'s `sectionProjectId` check
/// (store-tasks.ts) exactly.
#[derive(Default)]
struct LiveContainers {
    project_ids: std::collections::HashSet<String>,
    archived_project_ids: std::collections::HashSet<String>,
    section_project_ids: std::collections::HashMap<String, String>,
    archived_section_project_ids: std::collections::HashMap<String, String>,
    section_owner_project_ids: std::collections::HashMap<String, String>,
    area_ids: std::collections::HashSet<String>,
    next_project_orders: std::collections::HashMap<String, f64>,
}

impl LiveContainers {
    fn from_data(data: &Value) -> Self {
        let project_ids: std::collections::HashSet<String> = array_items(data, "projects")
            .into_iter()
            .filter(|project| {
                !has_string_field(project, "deletedAt") && !has_string_field(project, "purgedAt")
            })
            .filter_map(|project| {
                project
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        let archived_project_ids: std::collections::HashSet<String> = array_items(data, "projects")
            .into_iter()
            .filter(|project| project.get("status").and_then(Value::as_str) == Some("archived"))
            .filter_map(|project| {
                project
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        let section_owner_project_ids = array_items(data, "sections")
            .into_iter()
            .filter_map(|section| {
                let id = section.get("id").and_then(Value::as_str)?.to_string();
                let project_id = section
                    .get("projectId")
                    .and_then(Value::as_str)?
                    .to_string();
                Some((id, project_id))
            })
            .collect();
        let section_project_ids = array_items(data, "sections")
            .into_iter()
            .filter(|section| !has_string_field(section, "deletedAt"))
            .filter_map(|section| {
                let id = section.get("id").and_then(Value::as_str)?.to_string();
                let project_id = section
                    .get("projectId")
                    .and_then(Value::as_str)?
                    .to_string();
                project_ids
                    .contains(&project_id)
                    .then_some((id, project_id))
            })
            .collect();
        let archived_section_project_ids = array_items(data, "sections")
            .into_iter()
            .filter_map(|section| {
                let archived_at = section
                    .get("projectArchivedAt")
                    .and_then(Value::as_str)
                    .filter(|timestamp| !timestamp.is_empty())?;
                if section.get("deletedAt").and_then(Value::as_str) != Some(archived_at) {
                    return None;
                }
                let id = section.get("id").and_then(Value::as_str)?.to_string();
                let project_id = section
                    .get("projectId")
                    .and_then(Value::as_str)?
                    .to_string();
                (project_ids.contains(&project_id) && archived_project_ids.contains(&project_id))
                    .then_some((id, project_id))
            })
            .collect();
        let area_ids = array_items(data, "areas")
            .into_iter()
            .filter(|area| !has_string_field(area, "deletedAt"))
            .filter_map(|area| area.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let mut next_project_orders: std::collections::HashMap<String, f64> = project_ids
            .iter()
            .map(|project_id| (project_id.clone(), 0.0))
            .collect::<std::collections::HashMap<_, _>>();
        for task in array_items(data, "tasks") {
            if has_string_field(&task, "deletedAt") || has_string_field(&task, "purgedAt") {
                continue;
            }
            let Some(project_id) = task.get("projectId").and_then(Value::as_str) else {
                continue;
            };
            if !project_ids.contains(project_id) {
                continue;
            }
            let order = task
                .get("order")
                .and_then(Value::as_f64)
                .or_else(|| task.get("orderNum").and_then(Value::as_f64))
                .filter(|order| order.is_finite())
                .unwrap_or(-1.0);
            let next = order + 1.0;
            next_project_orders
                .entry(project_id.to_string())
                .and_modify(|existing| {
                    if next > *existing {
                        *existing = next;
                    }
                })
                .or_insert(next);
        }
        if let Some(reserved) = data
            .get(TASK_MUTATION_PROJECT_NEXT_ORDERS_KEY)
            .and_then(Value::as_object)
        {
            for (project_id, value) in reserved {
                let Some(next) = value.as_f64().filter(|next| next.is_finite()) else {
                    continue;
                };
                if project_ids.contains(project_id) {
                    next_project_orders.insert(project_id.clone(), next);
                }
            }
        }
        Self {
            project_ids,
            archived_project_ids,
            section_project_ids,
            archived_section_project_ids,
            section_owner_project_ids,
            area_ids,
            next_project_orders,
        }
    }
}

fn normalize_optional_container_id(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn finite_order_number(value: f64) -> Option<serde_json::Number> {
    if !value.is_finite() {
        return None;
    }
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        return Some((value as i64).into());
    }
    serde_json::Number::from_f64(value)
}

/// Direct Rust port of `resolveTaskContainerHierarchy` (task-container-rules.ts):
/// a section wins the project it lives under (or gets dropped if its project
/// isn't live/doesn't match), and an area only survives when no project is set.
struct ResolvedContainers {
    project_id: Option<String>,
    section_id: Option<String>,
    area_id: Option<String>,
}

fn resolve_task_container_hierarchy(
    project_id: Option<String>,
    section_id: Option<String>,
    area_id: Option<String>,
    section_project_id: Option<String>,
) -> ResolvedContainers {
    let mut next_project_id = project_id;
    let mut next_section_id = section_id;
    let mut next_area_id = area_id;

    if next_section_id.is_some() {
        if section_project_id.is_none() {
            next_section_id = None;
        } else if next_project_id.is_none() {
            next_project_id = section_project_id;
            next_area_id = None;
        } else if section_project_id != next_project_id {
            next_section_id = None;
        }
    }

    if next_area_id.is_some() && next_project_id.is_some() {
        next_area_id = None;
    }

    ResolvedContainers {
        project_id: next_project_id,
        section_id: next_section_id,
        area_id: next_area_id,
    }
}

fn set_or_remove_string(task: &mut Map<String, Value>, key: &str, value: Option<String>) {
    match value {
        Some(value) => {
            task.insert(key.to_string(), Value::String(value));
        }
        None => {
            task.remove(key);
        }
    }
}

fn archived_section_reference_project_id(
    task: &Map<String, Value>,
    section_id: &str,
    live: &LiveContainers,
) -> Option<String> {
    if !matches!(
        task.get("status").and_then(Value::as_str),
        Some("done" | "archived" | "reference")
    ) {
        return None;
    }
    let task_project_id = normalize_optional_container_id(task.get("projectId"))?;
    let section_project_id = live.archived_section_project_ids.get(section_id)?;
    (section_project_id == &task_project_id).then(|| section_project_id.clone())
}

fn normalize_created_task_containers(
    task: &mut Map<String, Value>,
    live: &LiveContainers,
) -> Result<(), String> {
    let project_id = normalize_optional_container_id(task.get("projectId"));
    if project_id
        .as_ref()
        .is_some_and(|id| !live.project_ids.contains(id))
    {
        return Err("Invalid task projectId: Project not found".to_string());
    }

    let section_id = normalize_optional_container_id(task.get("sectionId"));
    let section_project_id = section_id
        .as_ref()
        .and_then(|id| live.section_project_ids.get(id))
        .cloned();
    if section_id.is_some() && section_project_id.is_none() {
        return Err("Invalid task sectionId: Section not found".to_string());
    }
    if project_id.is_some() && section_project_id.is_some() && project_id != section_project_id {
        return Err("Invalid task sectionId: Section does not belong to project".to_string());
    }

    let area_id = normalize_optional_container_id(task.get("areaId"));
    let resolved =
        resolve_task_container_hierarchy(project_id, section_id, area_id, section_project_id);
    if resolved.project_id.is_none()
        && resolved
            .area_id
            .as_ref()
            .is_some_and(|id| !live.area_ids.contains(id))
    {
        return Err("Invalid task areaId: Area not found".to_string());
    }

    set_or_remove_string(task, "projectId", resolved.project_id);
    set_or_remove_string(task, "sectionId", resolved.section_id);
    set_or_remove_string(task, "areaId", resolved.area_id);
    Ok(())
}

fn normalize_task_container_patch(
    task: &Map<String, Value>,
    patch: &mut Map<String, Value>,
    live: &LiveContainers,
) -> Result<(), String> {
    let has_project_update = patch.contains_key("projectId");
    let has_section_update = patch.contains_key("sectionId");
    let has_area_update = patch.contains_key("areaId");
    let has_order_update = patch.contains_key("order") || patch.contains_key("orderNum");
    if !has_project_update && !has_section_update && !has_area_update {
        return Ok(());
    }

    let current_project_id = normalize_optional_container_id(task.get("projectId"));
    let current_section_id = normalize_optional_container_id(task.get("sectionId"));
    let current_area_id = normalize_optional_container_id(task.get("areaId"));
    let next_project_id = if has_project_update {
        normalize_optional_container_id(patch.get("projectId"))
    } else {
        current_project_id.clone()
    };
    let project_changed = current_project_id != next_project_id;
    let candidate_section_id = if has_section_update {
        normalize_optional_container_id(patch.get("sectionId"))
    } else if has_project_update && project_changed {
        None
    } else {
        current_section_id
    };
    let candidate_area_id = if has_area_update {
        normalize_optional_container_id(patch.get("areaId"))
    } else if has_project_update && project_changed && next_project_id.is_some() {
        None
    } else {
        current_area_id
    };

    if next_project_id
        .as_ref()
        .is_some_and(|id| !live.project_ids.contains(id))
    {
        return Err("Invalid task projectId: Project not found".to_string());
    }
    let mut section_project_id = candidate_section_id
        .as_ref()
        .and_then(|id| live.section_project_ids.get(id))
        .cloned();
    if section_project_id.is_none() && !has_section_update {
        section_project_id = candidate_section_id
            .as_ref()
            .and_then(|id| archived_section_reference_project_id(task, id, live));
    }
    if candidate_section_id.is_some() && section_project_id.is_none() {
        return Err("Invalid task sectionId: Section not found".to_string());
    }
    if next_project_id.is_some()
        && section_project_id.is_some()
        && next_project_id != section_project_id
    {
        return Err("Invalid task sectionId: Section does not belong to project".to_string());
    }

    let resolved = resolve_task_container_hierarchy(
        next_project_id,
        candidate_section_id,
        candidate_area_id,
        section_project_id,
    );
    if resolved.project_id.is_none()
        && resolved
            .area_id
            .as_ref()
            .is_some_and(|id| !live.area_ids.contains(id))
    {
        return Err("Invalid task areaId: Area not found".to_string());
    }

    let mut set_patch_value = |key: &str, value: Option<String>| match value {
        Some(value) => patch.insert(key.to_string(), Value::String(value)),
        None => patch.insert(key.to_string(), Value::Null),
    };
    set_patch_value("projectId", resolved.project_id.clone());
    set_patch_value("sectionId", resolved.section_id);
    set_patch_value("areaId", resolved.area_id);
    if project_changed && resolved.project_id.is_none() {
        patch.insert("order".to_string(), Value::Null);
        patch.insert("orderNum".to_string(), Value::Null);
    } else if project_changed && !has_order_update {
        if let Some(order) = resolved
            .project_id
            .as_ref()
            .and_then(|project_id| live.next_project_orders.get(project_id))
            .and_then(|order| finite_order_number(*order))
        {
            patch.insert("order".to_string(), Value::Number(order.clone()));
            patch.insert("orderNum".to_string(), Value::Number(order));
        }
    }
    Ok(())
}

fn reject_actionable_task_in_archived_project(
    task: &Map<String, Value>,
    patch: &Map<String, Value>,
    live: &LiveContainers,
) -> Result<(), String> {
    let final_project_id = if patch.contains_key("projectId") {
        normalize_optional_container_id(patch.get("projectId"))
    } else {
        normalize_optional_container_id(task.get("projectId"))
    };
    let final_section_id = if patch.contains_key("sectionId") {
        normalize_optional_container_id(patch.get("sectionId"))
    } else {
        normalize_optional_container_id(task.get("sectionId"))
    };
    let archived_project_owner = final_project_id
        .as_ref()
        .is_some_and(|project_id| live.archived_project_ids.contains(project_id))
        || final_section_id
            .as_ref()
            .and_then(|section_id| live.section_owner_project_ids.get(section_id))
            .is_some_and(|project_id| live.archived_project_ids.contains(project_id));
    if archived_project_owner {
        return Err(
            "Task status conflict: reactivate the archived project with PATCH /projects/:id status active, or move the task out in this patch"
                .to_string(),
        );
    }
    Ok(())
}

fn task_patch_read_scope(task_id: &str, patch: &Map<String, Value>) -> TaskMutationReadScope {
    TaskMutationReadScope::patch(
        task_id,
        patch.get("projectId").and_then(Value::as_str),
        patch.get("sectionId").and_then(Value::as_str),
        patch.get("areaId").and_then(Value::as_str),
        patch.get("isFocusedToday").and_then(Value::as_bool) == Some(true)
            || [
                "startTime",
                "relativeStartOffset",
                "status",
                "dueDate",
                "reviewAt",
                "recurrence",
                "projectId",
                "sectionId",
                "order",
                "orderNum",
            ]
            .iter()
            .any(|field| patch.contains_key(*field)),
    )
}

pub(crate) fn patch_task_in_data(
    data: &mut Value,
    task_id: &str,
    patch: &Map<String, Value>,
) -> Result<Value, String> {
    patch_task_in_data_at(
        data,
        task_id,
        patch,
        OffsetDateTime::now_utc(),
        &crate::local_query::local_wall,
    )
}

fn patch_task_in_data_at(
    data: &mut Value,
    task_id: &str,
    patch: &Map<String, Value>,
    now: OffsetDateTime,
    local_wall: &dyn Fn(OffsetDateTime) -> Option<PrimitiveDateTime>,
) -> Result<Value, String> {
    let device_id = device_id_from_data(data);
    let live_containers = LiveContainers::from_data(data);
    let current = find_task(data, task_id).ok_or("Task not found")?;
    let mut candidate = current.as_object().ok_or("Task is invalid")?.clone();
    let was_counted = local_api_task_is_counted_as_focused(&candidate, now, local_wall);
    let star_turning_on = patch.get("isFocusedToday").and_then(Value::as_bool) == Some(true)
        && candidate.get("isFocusedToday").and_then(Value::as_bool) != Some(true);
    apply_task_patch_with_containers(
        &mut candidate,
        patch,
        &device_id,
        &live_containers,
        data.pointer("/settings/taskReminderDefault")
            .and_then(Value::as_str)
            == Some("skip"),
    )?;
    if star_turning_on {
        if candidate.get("status").and_then(Value::as_str) == Some("inbox") {
            candidate.insert("status".to_string(), Value::String("next".to_string()));
            if !patch.contains_key("boardOrder") {
                candidate.remove("boardOrder");
            }
        }
        if candidate.get("status").and_then(Value::as_str) == Some("reference") {
            normalize_created_reference_task(&mut candidate);
        }
        let future_start = local_api_task_is_future_start(&candidate, now, local_wall);
        let queued = candidate.get("status").and_then(Value::as_str) == Some("next")
            && has_non_empty_string(&candidate, "startTime")
            && future_start;
        // Match core normalizeTaskUpdate: only a schedule/status edit clears a deferred star.
        if future_start
            && !queued
            && ["startTime", "dueDate", "reviewAt", "recurrence", "status"]
                .iter()
                .any(|field| patch.contains_key(*field))
        {
            candidate.insert("isFocusedToday".to_string(), Value::Bool(false));
        }
        if queued && !patch.contains_key("focusOrder") {
            candidate.remove("focusOrder");
        }
    }
    if !was_counted && local_api_task_is_counted_as_focused(&candidate, now, local_wall) {
        let n = local_api_focus_task_limit(data);
        if local_api_focused_task_count(data, now, local_wall) >= n {
            log::warn!("Local API refused a Focus star over the limit extra.releaseCheck=v1.3.5/local-api-patch-focus-limit limit={n}");
            return Err(format!("Focus limit of {n} reached"));
        }
    }
    update_task_in_data(data, task_id, |task| {
        *task = candidate;
        Ok(())
    })
}

/// Direct Rust port of `sanitizeRestoredTaskContainerReferences`
/// (store-tasks.ts): a restored task never keeps a reference to a
/// project/section/area that no longer exists.
fn sanitize_restored_task_container_references(
    task: &mut Map<String, Value>,
    live: &LiveContainers,
) {
    let mut project_id = normalize_optional_container_id(task.get("projectId"));
    let mut section_id = normalize_optional_container_id(task.get("sectionId"));
    let area_id = normalize_optional_container_id(task.get("areaId"));

    let section_project_id = section_id
        .as_ref()
        .and_then(|id| live.section_project_ids.get(id))
        .cloned();

    if project_id
        .as_ref()
        .is_some_and(|id| !live.project_ids.contains(id))
    {
        project_id = None;
    }
    if section_id.is_some() && section_project_id.is_none() {
        section_id = None;
    }

    let resolved =
        resolve_task_container_hierarchy(project_id, section_id, area_id, section_project_id);
    let mut resolved_area_id = resolved.area_id;
    if resolved_area_id
        .as_ref()
        .is_some_and(|id| !live.area_ids.contains(id))
    {
        resolved_area_id = None;
    }

    set_or_remove_string(task, "projectId", resolved.project_id);
    set_or_remove_string(task, "sectionId", resolved.section_id);
    set_or_remove_string(task, "areaId", resolved_area_id);
}

/// A completedAt value counts as set only if it's a non-empty string -
/// mirrors core's `oldTask.completedAt || now` falsy fallback
/// (applyTaskUpdates in store-helpers.ts) so complete's archived-correction
/// branch and archive's own completedAt fallback use the same rule.
fn has_non_empty_string(task: &Map<String, Value>, key: &str) -> bool {
    task.get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

// Cancellation is an archived outcome, never a completed occurrence. Keep this
// boundary aligned with core's normalizeTaskLifecycleFields for native writes.
fn normalize_local_task_lifecycle(
    task: &mut Map<String, Value>,
    now: &str,
    previous_status: Option<&str>,
) {
    let status = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("inbox")
        .to_string();
    if status == "archived" && previous_status != Some("archived") {
        task.insert("archivedAt".to_string(), Value::String(now.to_string()));
    } else if status != "archived" && previous_status == Some("archived") {
        task.remove("archivedAt");
    }
    let has_valid_cancellation =
        status == "archived" && valid_cancellation_timestamp(task.get("cancelledAt"));
    if !has_valid_cancellation {
        task.remove("cancelledAt");
    }
    if has_valid_cancellation {
        task.remove("completedAt");
    } else if matches!(status.as_str(), "done" | "archived") {
        if !has_non_empty_string(task, "completedAt") {
            task.insert("completedAt".to_string(), Value::String(now.to_string()));
        }
    } else {
        task.remove("completedAt");
    }
    if matches!(status.as_str(), "done" | "archived") {
        task.insert("isFocusedToday".to_string(), Value::Bool(false));
        task.remove("focusOrder");
    }
}

/// The complete/archive/restore mutation lifted out of `route_api_request`'s
/// closure (previously untestable without a `tauri::AppHandle`). Mirrors
/// core's write-invariant home for tasks: `applyTaskUpdates` for
/// complete/archive (composed after `normalizeTaskUpdate`'s boardOrder
/// clearing, per the store's own `updateTask`), `sanitizeRestoredTaskContainerReferences`
/// for restore. Returns the recurring follow-up task to insert alongside
/// `task`, if the action spawns one; `task` is mutated in place with
/// `updatedAt`/`rev`/`revBy` stamped, matching every write path in core
/// (`mutateTasks`/`updateTask`) - except when the status isn't actually
/// changing (complete on an already-done task, archive on an already-archived
/// one), which is a full no-op: core's `statusChanged` gate means nothing in
/// `applyTaskUpdates` would touch the task, so nothing here should either.
fn apply_task_action(
    task: &mut Map<String, Value>,
    action: &str,
    previous_status: &str,
    now: &str,
    device_id: &str,
    live_containers: &LiveContainers,
) -> Result<Option<Map<String, Value>>, String> {
    let target_status = match action {
        "complete" => Some("done"),
        "archive" => Some("archived"),
        "restore" => None,
        _ => return Err(format!("Unsupported task action: {action}")),
    };
    if target_status.is_some_and(|target| target == previous_status) {
        return Ok(None);
    }

    let mut recurring_follow_up = None;
    match action {
        "complete" => {
            let previous_task = task.clone();
            task.remove("cancelledAt");
            task.remove("archivedAt");
            // archived -> done is a lifecycle correction, not a new
            // completion: keep the existing completedAt (falling back to
            // `now` only if it is somehow missing) instead of overwriting it,
            // and never spawn a follow-up occurrence.
            let is_archive_correction = previous_status == "archived";
            task.insert("status".to_string(), Value::String("done".to_string()));
            if !is_archive_correction || !has_non_empty_string(task, "completedAt") {
                task.insert("completedAt".to_string(), Value::String(now.to_string()));
            }
            task.insert("isFocusedToday".to_string(), Value::Bool(false));
            // A manual Focus position only means something while starred;
            // completing always unstars, so it must take focusOrder with it.
            // boardOrder also resets on a status change unless the same
            // patch sets it itself, which the server-triggered complete/
            // archive actions never do (normalizeTaskUpdate's rule).
            task.remove("focusOrder");
            task.remove("boardOrder");
            if should_create_recurring_follow_up(action, previous_status) {
                recurring_follow_up =
                    create_next_recurring_task_for_local_api(&previous_task, now, previous_status)
                        .map(|mut next_task| {
                            bump_task_revision(&mut next_task, device_id);
                            next_task
                        });
            }
        }
        "archive" => {
            task.insert("status".to_string(), Value::String("archived".to_string()));
            task.insert("archivedAt".to_string(), Value::String(now.to_string()));
            if !has_non_empty_string(task, "completedAt") {
                task.insert("completedAt".to_string(), Value::String(now.to_string()));
            }
            task.insert("isFocusedToday".to_string(), Value::Bool(false));
            task.remove("focusOrder");
            task.remove("boardOrder");
        }
        "restore" => {
            // Mirrors core's `restoreTask`: a purged task is the compacted
            // tombstone of a permanent delete, so reviving it would resurrect
            // an emptied row and sync it back to every device.
            if has_non_empty_string(task, "purgedAt") {
                return Err("Task status conflict: purged task cannot be restored".to_string());
            }
            task.remove("deletedAt");
            sanitize_restored_task_container_references(task, live_containers);
        }
        _ => unreachable!("action already validated above"),
    }
    task.insert("updatedAt".to_string(), Value::String(now.to_string()));
    bump_task_revision(task, device_id);
    Ok(recurring_follow_up)
}

fn parse_body_object(body: &[u8]) -> Result<Map<String, Value>, String> {
    if body.is_empty() {
        return Err("Invalid JSON body".to_string());
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid JSON body".to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "Invalid JSON body".to_string())
}

fn device_id_from_data(data: &Value) -> String {
    data.get("settings")
        .and_then(|settings| settings.get("deviceId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(LOCAL_API_REV_BY)
        .to_string()
}

fn next_revision(value: Option<&Value>) -> i64 {
    let current = value
        .and_then(|value| value.as_i64())
        .filter(|value| *value >= 0)
        .unwrap_or(0);
    if current >= MAX_SYNC_REVISION {
        MAX_SYNC_REVISION
    } else {
        current + 1
    }
}

fn bump_task_revision(task: &mut Map<String, Value>, device_id: &str) {
    task.insert(
        "rev".to_string(),
        Value::Number(next_revision(task.get("rev")).into()),
    );
    task.insert("revBy".to_string(), Value::String(device_id.to_string()));
}

/// True when the recurrence carries selectors this fixed interval/anchor-day
/// engine cannot compute: explicit weekdays, explicit month days, a raw
/// RFC 5545 fragment (which may itself encode BYSETPOS or other selectors
/// this engine never parses), or a `relativeStartOffset` (which core's
/// `createNextRecurringTask` recomputes onto the follow-up's startTime -
/// this engine doesn't carry it at all). Only `packages/core/src/recurrence.ts`
/// understands these — the local API must refuse rather than guess a date.
fn recurrence_needs_core_engine(task: &Map<String, Value>) -> bool {
    if task
        .get("relativeStartOffset")
        .is_some_and(|value| !value.is_null())
    {
        return true;
    }
    let Some(Value::Object(recurrence)) = recurrence_value(task) else {
        return false;
    };
    let has_by_day = recurrence
        .get("byDay")
        .and_then(Value::as_array)
        .is_some_and(|values| !values.is_empty());
    let has_by_month_day = recurrence
        .get("byMonthDay")
        .and_then(Value::as_array)
        .is_some_and(|values| !values.is_empty());
    let has_rrule = recurrence
        .get("rrule")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    has_by_day || has_by_month_day || has_rrule
}

// Catchup belongs to core; refuse before changing the source when one step is stale.
fn recurrence_start_needs_catchup(task: &Map<String, Value>, completed_at: &str) -> bool {
    if recurrence_strategy(task) == "fluid"
        || has_non_empty_string(task, "dueDate")
        || recurrence_count(task)
            .is_some_and(|count| recurrence_completed_occurrences(task).unwrap_or(0) + 1 >= count)
    {
        return false;
    }
    let (Some(source), Some(rule)) = (
        task.get("startTime")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty()),
        recurrence_rule(task),
    ) else {
        return false;
    };
    let Some(next) = next_recurring_iso(
        source,
        completed_at,
        rule,
        "strict",
        recurrence_interval(task),
        recurrence_anchor_day_for_field(task, "startAnchorDay", "startTime"),
    ) else {
        return true;
    };
    if let Some(until) = recurrence_until(task) {
        let certainly_ended = if next.len() == 10 && until.len() == 10 {
            next > until
        } else if let (Ok(next), Ok(until)) = (
            OffsetDateTime::parse(&next, &Rfc3339),
            OffsetDateTime::parse(&until, &Rfc3339),
        ) {
            next > until
        } else {
            false
        };
        if certainly_ended && should_stop_at_until(Some(&next), &until) {
            return false;
        }
    }
    let Ok(completed) = OffsetDateTime::parse(completed_at, &Rfc3339) else {
        return true;
    };
    if let Ok(next) = OffsetDateTime::parse(&next, &Rfc3339) {
        return next <= completed;
    }
    let Some(completed) = crate::local_query::local_wall(completed) else {
        return true;
    };
    let floating = if next.len() == 16 {
        format!("{next}:00")
    } else {
        next.clone()
    };
    let Some(candidate) = crate::local_query::parse_local_date(&floating) else {
        return true;
    };
    if next.len() == 10 {
        candidate.date() < completed.date()
    } else {
        candidate <= completed
    }
}

fn create_next_recurring_task_for_local_api(
    task: &Map<String, Value>,
    completed_at: &str,
    previous_status: &str,
) -> Option<Map<String, Value>> {
    let rule = recurrence_rule(task)?;
    if recurrence_needs_core_engine(task) || recurrence_start_needs_catchup(task, completed_at) {
        // Refuse what this engine cannot model instead of guessing a wrong
        // date (e.g. an every-Mon/Wed/Fri task otherwise gets a follow-up 7
        // days out because `next_recurring_iso` below only knows fixed
        // day/week/month steps). The HTTP complete handler already refuses
        // this case via `recurrence_completion_refusal` before this function
        // is ever reached, so the task is never marked done without its
        // follow-up — a vanished recurring series would be worse than a
        // rejected request. This `None` is a defensive backstop for any
        // other caller (tests call this function directly).
        return None;
    }
    let interval = recurrence_interval(task);
    let strategy = recurrence_strategy(task);
    let completed_occurrences = recurrence_completed_occurrences(task).unwrap_or(0);
    if let Some(count) = recurrence_count(task) {
        if completed_occurrences + 1 >= count {
            return None;
        }
    }

    let strict_anchors = strategy != "fluid";
    let due_anchor_day = strict_anchors
        .then(|| recurrence_anchor_day_for_field(task, "dueAnchorDay", "dueDate"))
        .flatten();
    let start_anchor_day = strict_anchors
        .then(|| recurrence_anchor_day_for_field(task, "startAnchorDay", "startTime"))
        .flatten();
    let review_anchor_day = strict_anchors
        .then(|| recurrence_anchor_day_for_field(task, "reviewAnchorDay", "reviewAt"))
        .flatten();
    let next_due_date = task
        .get("dueDate")
        .and_then(|value| value.as_str())
        .and_then(|value| {
            next_recurring_iso(
                value,
                completed_at,
                rule,
                strategy,
                interval,
                due_anchor_day,
            )
        });
    let mut next_start_time = task
        .get("startTime")
        .and_then(|value| value.as_str())
        .and_then(|value| {
            next_recurring_iso(
                value,
                completed_at,
                rule,
                strategy,
                interval,
                start_anchor_day,
            )
        });
    let next_review_at = task
        .get("reviewAt")
        .and_then(|value| value.as_str())
        .and_then(|value| {
            next_recurring_iso(
                value,
                completed_at,
                rule,
                strategy,
                interval,
                review_anchor_day,
            )
        });

    if next_start_time.is_none() && next_due_date.is_none() && next_review_at.is_none() {
        // Date-only deferral: an unscheduled task must not inherit the completion's
        // time of day. Mirrors the core TypeScript behavior (ISO date prefix).
        let completed_at_date = completed_at.get(..10).unwrap_or(completed_at);
        next_start_time = next_recurring_iso(
            completed_at,
            completed_at_date,
            rule,
            "fluid",
            interval,
            None,
        );
    }

    let next_occurrence_anchor = next_due_date
        .as_deref()
        .or(next_start_time.as_deref())
        .or(next_review_at.as_deref());
    if recurrence_until(task)
        .as_deref()
        .is_some_and(|until| should_stop_at_until(next_occurrence_anchor, until))
    {
        return None;
    }

    let mut next_task = Map::new();
    next_task.insert("id".to_string(), Value::String(generate_uuid_v4()));
    next_task.insert(
        "title".to_string(),
        task.get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("Untitled")
            .to_string()
            .into(),
    );
    let next_status = if previous_status == "done" || previous_status == "archived" {
        "next"
    } else {
        previous_status
    };
    next_task.insert("status".to_string(), Value::String(next_status.to_string()));
    copy_task_fields(
        task,
        &mut next_task,
        &[
            "priority",
            "energyLevel",
            "assignedTo",
            "taskMode",
            "description",
            "textDirection",
            "location",
            "projectId",
            "sectionId",
            "areaId",
            "timeEstimate",
            "repeatReminderMinutes",
            "reminderPolicy",
        ],
    );
    if let Some(value) = next_start_time {
        next_task.insert("startTime".to_string(), Value::String(value));
    }
    if let Some(value) = next_due_date {
        next_task.insert("dueDate".to_string(), Value::String(value));
    }
    if let Some(value) = next_review_at {
        next_task.insert("reviewAt".to_string(), Value::String(value));
    }
    if let Some(recurrence) = next_recurrence_value(task, completed_occurrences + 1, rule) {
        next_task.insert("recurrence".to_string(), recurrence);
    }
    if task
        .get("showFutureRecurrence")
        .and_then(|value| value.as_bool())
        == Some(true)
    {
        next_task.insert("showFutureRecurrence".to_string(), Value::Bool(true));
    }
    if task
        .get("suppressMindwtrReminders")
        .and_then(|value| value.as_bool())
        == Some(true)
    {
        next_task.insert("suppressMindwtrReminders".to_string(), Value::Bool(true));
    }
    next_task.insert(
        "tags".to_string(),
        task.get("tags")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    next_task.insert(
        "contexts".to_string(),
        task.get("contexts")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    if let Some(checklist) = reset_checklist_value(task.get("checklist")) {
        next_task.insert("checklist".to_string(), checklist);
    }
    if let Some(attachments) = duplicate_attachment_value(task.get("attachments"), completed_at) {
        next_task.insert("attachments".to_string(), attachments);
    }
    next_task.insert("isFocusedToday".to_string(), Value::Bool(false));
    next_task.insert(
        "createdAt".to_string(),
        Value::String(completed_at.to_string()),
    );
    next_task.insert(
        "updatedAt".to_string(),
        Value::String(completed_at.to_string()),
    );
    Some(next_task)
}

fn should_create_recurring_follow_up(action: &str, previous_status: &str) -> bool {
    // Completing a task that was already archived is a lifecycle correction
    // (archived -> done), not a new completion event: core never spawns a
    // follow-up occurrence for it (store-helpers.ts's applyTaskUpdates treats
    // `isReturningFromArchive` as `nextRecurringTask = null` regardless of
    // recurrence), and this is also the sole gate the 409 refusal check
    // (`recurrence_completion_refusal`) uses to decide whether to even look at
    // the recurrence rule — so an archived-source completion is never refused
    // either, even when its recurrence is one this engine cannot compute.
    action == "complete" && previous_status != "done" && previous_status != "archived"
}

fn recurrence_value(task: &Map<String, Value>) -> Option<&Value> {
    task.get("recurrence")
}

fn recurrence_rule(task: &Map<String, Value>) -> Option<&str> {
    match recurrence_value(task)? {
        Value::String(value) if is_recurrence_rule(value) => Some(value.as_str()),
        Value::Object(value) => value
            .get("rule")
            .and_then(|rule| rule.as_str())
            .filter(|rule| is_recurrence_rule(rule)),
        _ => None,
    }
}

fn is_recurrence_rule(value: &str) -> bool {
    matches!(value, "daily" | "weekly" | "monthly" | "yearly")
}

fn recurrence_strategy(task: &Map<String, Value>) -> &str {
    match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("strategy")
            .and_then(|strategy| strategy.as_str())
            .filter(|strategy| *strategy == "fluid")
            .unwrap_or("strict"),
        _ => "strict",
    }
}

fn recurrence_interval(task: &Map<String, Value>) -> i64 {
    match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("interval")
            .and_then(|interval| interval.as_i64())
            .filter(|interval| *interval > 0)
            .unwrap_or(1),
        _ => 1,
    }
}

fn recurrence_count(task: &Map<String, Value>) -> Option<i64> {
    match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("count")
            .and_then(|count| count.as_i64())
            .filter(|count| *count > 0),
        _ => None,
    }
}

fn recurrence_completed_occurrences(task: &Map<String, Value>) -> Option<i64> {
    match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("completedOccurrences")
            .and_then(|count| count.as_i64())
            .filter(|count| *count >= 0),
        _ => None,
    }
}

fn recurrence_until(task: &Map<String, Value>) -> Option<String> {
    match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("until")
            .and_then(|until| until.as_str())
            .map(str::to_string),
        _ => None,
    }
}

fn normalized_anchor_day(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(|value| value.as_i64())
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| (1..=31).contains(value))
}

fn recurrence_anchor_day_value(task: &Map<String, Value>, key: &str) -> Option<u32> {
    match recurrence_value(task) {
        Some(Value::Object(value)) => normalized_anchor_day(value.get(key)),
        _ => None,
    }
}

fn iso_day(value: &str) -> Option<u32> {
    parse_iso_prefix(value).map(|(_, _, day, _)| day)
}

// The legacy single `anchorDay` is credited ONLY to the field it was derived
// from (dueDate, else startTime, else reviewAt — the order that writes it).
// Letting it anchor the other fields advanced a start of the 14th as a day-15
// rule, so "start 14th / due 15th, monthly" came back starting Aug 15 instead
// of Sep 14. Mirrors resolveRecurrenceFieldAnchorDays in core's recurrence.ts;
// the shared parity fixtures pin both sides.
fn recurrence_anchor_owner_field(task: &Map<String, Value>) -> Option<&'static str> {
    ["dueDate", "startTime", "reviewAt"]
        .into_iter()
        .find(|key| {
            task.get(*key)
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.trim().is_empty())
        })
}

fn recurrence_anchor_day_for_field(
    task: &Map<String, Value>,
    field_anchor_key: &str,
    field_key: &str,
) -> Option<u32> {
    recurrence_anchor_day_value(task, field_anchor_key)
        .or_else(|| {
            (recurrence_anchor_owner_field(task) == Some(field_key))
                .then(|| recurrence_anchor_day_value(task, "anchorDay"))
                .flatten()
        })
        .or_else(|| {
            task.get(field_key)
                .and_then(|value| value.as_str())
                .and_then(iso_day)
        })
}

fn next_recurrence_anchor_days(task: &Map<String, Value>, rule: &str) -> Map<String, Value> {
    let mut anchors = Map::new();
    if rule != "monthly" && rule != "yearly" {
        return anchors;
    }

    let start_anchor_day = recurrence_anchor_day_for_field(task, "startAnchorDay", "startTime");
    let due_anchor_day = recurrence_anchor_day_for_field(task, "dueAnchorDay", "dueDate");
    let review_anchor_day = recurrence_anchor_day_for_field(task, "reviewAnchorDay", "reviewAt");
    let anchor_day = recurrence_anchor_day_value(task, "anchorDay")
        .or(due_anchor_day)
        .or(start_anchor_day)
        .or(review_anchor_day);

    if let Some(value) = anchor_day {
        anchors.insert("anchorDay".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = start_anchor_day {
        anchors.insert("startAnchorDay".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = due_anchor_day {
        anchors.insert("dueAnchorDay".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = review_anchor_day {
        anchors.insert("reviewAnchorDay".to_string(), Value::Number(value.into()));
    }
    anchors
}

fn next_recurrence_value(
    task: &Map<String, Value>,
    completed_occurrences: i64,
    rule: &str,
) -> Option<Value> {
    let anchor_days = next_recurrence_anchor_days(task, rule);
    let series_id = match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("seriesId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty()),
        _ => None,
    }
    .or_else(|| task.get("id").and_then(Value::as_str))?;
    match recurrence_value(task)? {
        Value::Object(value) => {
            let mut next = value.clone();
            next.insert("seriesId".to_string(), Value::String(series_id.to_string()));
            for (key, value) in anchor_days {
                next.insert(key, value);
            }
            if value
                .get("count")
                .and_then(|count| count.as_i64())
                .is_some()
            {
                next.insert(
                    "completedOccurrences".to_string(),
                    Value::Number(serde_json::Number::from(completed_occurrences)),
                );
            }
            Some(Value::Object(next))
        }
        Value::String(value) => {
            let mut next = anchor_days;
            next.insert("rule".to_string(), Value::String(value.clone()));
            next.insert("seriesId".to_string(), Value::String(series_id.to_string()));
            Some(Value::Object(next))
        }
        value => Some(value.clone()),
    }
}

fn next_recurring_iso(
    source_iso: &str,
    completed_at: &str,
    rule: &str,
    strategy: &str,
    interval: i64,
    anchor_day: Option<u32>,
) -> Option<String> {
    let base_iso = if strategy == "fluid" {
        completed_at
    } else {
        source_iso
    };
    let (year, month, day, suffix) = parse_iso_prefix(base_iso)?;
    let (next_year, next_month, next_day) = match rule {
        "daily" => add_days(year, month, day, interval),
        "weekly" => add_days(year, month, day, interval.saturating_mul(7)),
        "monthly" => add_months(year, month, anchor_day.unwrap_or(day), interval),
        "yearly" => add_months(
            year,
            month,
            anchor_day.unwrap_or(day),
            interval.saturating_mul(12),
        ),
        _ => return None,
    };
    Some(format!(
        "{next_year:04}-{next_month:02}-{next_day:02}{suffix}"
    ))
}

fn parse_iso_prefix(value: &str) -> Option<(i32, u32, u32, &str)> {
    if value.len() < 10 || &value[4..5] != "-" || &value[7..8] != "-" {
        return None;
    }
    let year = value[0..4].parse::<i32>().ok()?;
    let month = value[5..7].parse::<u32>().ok()?;
    let day = value[8..10].parse::<u32>().ok()?;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    Some((year, month, day, &value[10..]))
}

fn add_days(year: i32, month: u32, day: u32, days: i64) -> (i32, u32, u32) {
    civil_from_days(days_from_civil(year, month, day).saturating_add(days))
}

fn add_months(year: i32, month: u32, day: u32, months: i64) -> (i32, u32, u32) {
    let total_months = i64::from(year)
        .saturating_mul(12)
        .saturating_add(i64::from(month) - 1)
        .saturating_add(months);
    let next_year = total_months.div_euclid(12) as i32;
    let next_month = total_months.rem_euclid(12) as u32 + 1;
    let next_day = day.min(days_in_month(next_year, next_month));
    (next_year, next_month, next_day)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 30,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let mut y = i64::from(year);
    let m = i64::from(month);
    let d = i64::from(day);
    y -= if m <= 2 { 1 } else { 0 };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let month_adjusted = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * month_adjusted + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

fn should_stop_at_until(next_iso: Option<&str>, until: &str) -> bool {
    let Some(next_iso) = next_iso else {
        return false;
    };
    if until.len() == 10 {
        return next_iso
            .get(0..10)
            .is_some_and(|next_date| next_date > until);
    }
    next_iso > until
}

fn copy_task_fields(source: &Map<String, Value>, target: &mut Map<String, Value>, keys: &[&str]) {
    for key in keys {
        if let Some(value) = source.get(*key).filter(|value| !value.is_null()) {
            target.insert((*key).to_string(), value.clone());
        }
    }
}

fn reset_checklist_value(value: Option<&Value>) -> Option<Value> {
    let checklist = value?.as_array()?;
    if checklist.is_empty() {
        return None;
    }
    Some(Value::Array(
        checklist
            .iter()
            .filter_map(|item| {
                let mut item = item.as_object()?.clone();
                item.insert("id".to_string(), Value::String(generate_uuid_v4()));
                item.insert("isCompleted".to_string(), Value::Bool(false));
                Some(Value::Object(item))
            })
            .collect(),
    ))
}

fn duplicate_attachment_value(value: Option<&Value>, timestamp: &str) -> Option<Value> {
    let attachments = value?.as_array()?;
    let duplicated = attachments
        .iter()
        .filter_map(|attachment| {
            if has_string_field(attachment, "deletedAt") {
                return None;
            }
            let mut attachment = attachment.as_object()?.clone();
            attachment.insert("id".to_string(), Value::String(generate_uuid_v4()));
            attachment.insert(
                "createdAt".to_string(),
                Value::String(timestamp.to_string()),
            );
            attachment.insert(
                "updatedAt".to_string(),
                Value::String(timestamp.to_string()),
            );
            attachment.remove("deletedAt");
            // A duplicate is a distinct attachment record; sharing the original's
            // cloud identity would point two records at one cloud blob (A4).
            attachment.remove("cloudKey");
            attachment.remove("fileHash");
            attachment.remove("localStatus");
            attachment.remove("contentRev");
            attachment.remove("contentMtimeMs");
            attachment.remove("contentSize");
            attachment.remove("pendingContentUpload");
            attachment.remove("staleContentHash");
            Some(Value::Object(attachment))
        })
        .collect::<Vec<_>>();
    if duplicated.is_empty() {
        None
    } else {
        Some(Value::Array(duplicated))
    }
}

fn normalize_created_reference_task(task: &mut Map<String, Value>) {
    for key in [
        "startTime",
        "dueDate",
        "relativeStartOffset",
        "reviewAt",
        "recurrence",
        "priority",
        "timeEstimate",
        "suppressMindwtrReminders",
        "repeatReminderMinutes",
        "showFutureRecurrence",
        "focusOrder",
        "boardOrder",
    ] {
        task.remove(key);
    }
    task.insert("isFocusedToday".to_string(), Value::Bool(false));
    task.insert("pushCount".to_string(), Value::Number(0.into()));
}

fn local_api_due_schedule_time(
    value: Option<&Value>,
    local_wall: &dyn Fn(OffsetDateTime) -> Option<PrimitiveDateTime>,
) -> Option<PrimitiveDateTime> {
    if let Some(date) = parse_iso_date_bytes(value?.as_str()?.as_bytes()) {
        return date.with_hms_milli(23, 59, 59, 999).ok();
    }
    local_api_focus_schedule_time(value, local_wall)
}

fn local_api_review_is_due(
    task: &Map<String, Value>,
    now: OffsetDateTime,
    local_wall: &dyn Fn(OffsetDateTime) -> Option<PrimitiveDateTime>,
) -> bool {
    let utc = now.to_offset(time::UtcOffset::UTC);
    let now = local_wall(now).unwrap_or(PrimitiveDateTime::new(utc.date(), utc.time()));
    local_api_focus_schedule_time(task.get("reviewAt"), local_wall)
        .is_some_and(|review| review <= now)
}

fn local_api_focus_schedule_time(
    value: Option<&Value>,
    local_wall: &dyn Fn(OffsetDateTime) -> Option<PrimitiveDateTime>,
) -> Option<PrimitiveDateTime> {
    let value = value?.as_str()?;
    let parse = |value: &str| {
        crate::local_query::parse_local_date(value).or_else(|| {
            let instant = OffsetDateTime::parse(value, &Rfc3339).ok()?;
            let utc = instant.to_offset(time::UtcOffset::UTC);
            Some(local_wall(instant).unwrap_or(PrimitiveDateTime::new(utc.date(), utc.time())))
        })
    };
    parse(value).or_else(|| {
        if matches!(
            value.as_bytes().get(16),
            None | Some(b'Z' | b'z' | b'+' | b'-')
        ) {
            parse(&format!("{}:00{}", value.get(..16)?, value.get(16..)?))
        } else {
            None
        }
    })
}

fn local_api_task_is_future_start(
    task: &Map<String, Value>,
    now: OffsetDateTime,
    local_wall: &dyn Fn(OffsetDateTime) -> Option<PrimitiveDateTime>,
) -> bool {
    let defer_until =
        local_api_focus_schedule_time(task.get("startTime"), local_wall).or_else(|| {
            recurrence_rule(task).and_then(|_| {
                [
                    local_api_focus_schedule_time(task.get("dueDate"), local_wall),
                    local_api_focus_schedule_time(task.get("reviewAt"), local_wall),
                ]
                .into_iter()
                .flatten()
                .min()
            })
        });
    let today = local_wall(now)
        .map(|value| value.date())
        .unwrap_or_else(|| now.to_offset(time::UtcOffset::UTC).date());
    defer_until.is_some_and(|value| value.date() > today)
}

fn local_api_focus_task_limit(data: &Value) -> usize {
    let raw = data
        .get("settings")
        .and_then(|settings| settings.get("gtd"))
        .and_then(|gtd| gtd.get("focusTaskLimit"));
    let numeric = raw.and_then(Value::as_f64).or_else(|| {
        raw.and_then(Value::as_str)
            .and_then(|value| value.parse().ok())
    });
    numeric
        .filter(|value| value.is_finite())
        .map(|value| value.floor().clamp(1.0, 10.0) as usize)
        .unwrap_or(3)
}

pub(crate) fn local_api_task_is_counted_as_focused(
    task: &Map<String, Value>,
    now: OffsetDateTime,
    local_wall: &dyn Fn(OffsetDateTime) -> Option<PrimitiveDateTime>,
) -> bool {
    !has_non_empty_string(task, "deletedAt")
        && task.get("isFocusedToday").and_then(Value::as_bool) == Some(true)
        && !matches!(
            task.get("status").and_then(Value::as_str),
            Some("done" | "reference" | "archived")
        )
        && !local_api_task_is_future_start(task, now, local_wall)
}

fn local_api_focused_task_count(
    data: &Value,
    now: OffsetDateTime,
    local_wall: &dyn Fn(OffsetDateTime) -> Option<PrimitiveDateTime>,
) -> usize {
    if let Some(count) = data
        .get(TASK_MUTATION_FOCUSED_COUNT_KEY)
        .and_then(Value::as_u64)
    {
        return count as usize;
    }
    array_items(data, "tasks")
        .iter()
        .filter(|task| {
            task.as_object()
                .is_some_and(|task| local_api_task_is_counted_as_focused(task, now, local_wall))
        })
        .count()
}

fn local_api_project_allows_focus(task: &Map<String, Value>, data: &Value) -> bool {
    let Some(project_id) = task.get("projectId").and_then(Value::as_str) else {
        return true;
    };
    let Some(project) = array_items(data, "projects")
        .into_iter()
        .find(|project| project.get("id").and_then(Value::as_str) == Some(project_id))
    else {
        return true;
    };
    !has_string_field(&project, "deletedAt")
        && (project.get("status").and_then(Value::as_str) == Some("active")
            || project.get("isFocused").and_then(Value::as_bool) == Some(true))
}

fn local_api_focus_schedule_key(
    task: &Map<String, Value>,
    now: OffsetDateTime,
    local_wall: &dyn Fn(OffsetDateTime) -> Option<PrimitiveDateTime>,
) -> (u8, PrimitiveDateTime) {
    if task.get("isFocusedToday").and_then(Value::as_bool) == Some(true) {
        return (0, PrimitiveDateTime::MIN);
    }
    let utc = now.to_offset(time::UtcOffset::UTC);
    let now_wall = local_wall(now).unwrap_or(PrimitiveDateTime::new(utc.date(), utc.time()));
    let mut scheduled = Vec::new();
    if let Some(due) = local_api_due_schedule_time(task.get("dueDate"), local_wall) {
        if due.date() <= now_wall.date()
            && task.get("status").and_then(Value::as_str) != Some("waiting")
        {
            scheduled.push(due);
        }
    }
    if local_api_review_is_due(task, now, local_wall) {
        if let Some(review) = local_api_focus_schedule_time(task.get("reviewAt"), local_wall) {
            scheduled.push(review);
        }
    }
    scheduled
        .into_iter()
        .min()
        .map(|time| (1, time))
        .unwrap_or((2, PrimitiveDateTime::MAX))
}

fn local_api_focus_order(task: &Map<String, Value>, has_order: bool) -> f64 {
    if has_order {
        return task
            .get("order")
            .and_then(Value::as_f64)
            .or_else(|| task.get("orderNum").and_then(Value::as_f64))
            .filter(|value| value.is_finite())
            .unwrap_or(f64::INFINITY);
    }
    task.get("createdAt")
        .and_then(Value::as_str)
        .and_then(|value| {
            parse_iso_date_bytes(value.as_bytes())
                .map(|date| date.midnight().assume_utc())
                .or_else(|| OffsetDateTime::parse(value, &Rfc3339).ok())
        })
        .map(|value| value.unix_timestamp_nanos() as f64)
        .unwrap_or(f64::INFINITY)
}

fn local_api_focus_candidate_is_sequential_first(
    candidate: &Map<String, Value>,
    data: &Value,
    now: OffsetDateTime,
    local_wall: &dyn Fn(OffsetDateTime) -> Option<PrimitiveDateTime>,
) -> bool {
    let Some(project_id) = candidate.get("projectId").and_then(Value::as_str) else {
        return true;
    };
    let Some(project) = array_items(data, "projects")
        .into_iter()
        .find(|project| project.get("id").and_then(Value::as_str) == Some(project_id))
    else {
        return true;
    };
    if project.get("isSequential").and_then(Value::as_bool) != Some(true) {
        return true;
    }
    let section_scoped = project.get("sequentialScope").and_then(Value::as_str) == Some("section");
    let candidate_section = candidate.get("sectionId").and_then(Value::as_str);
    let mut candidates = array_items(data, "tasks")
        .into_iter()
        .filter_map(|task| {
            let task = task.as_object()?.clone();
            if has_string_field(&Value::Object(task.clone()), "deletedAt")
                || task.get("id") == candidate.get("id")
                || task.get("projectId").and_then(Value::as_str) != Some(project_id)
                || (section_scoped
                    && task.get("sectionId").and_then(Value::as_str) != candidate_section)
                || !matches!(
                    task.get("status").and_then(Value::as_str),
                    Some("inbox" | "next" | "waiting" | "someday")
                )
                || !(task.get("isFocusedToday").and_then(Value::as_bool) == Some(true)
                    || task.get("status").and_then(Value::as_str) == Some("next")
                    || local_api_review_is_due(&task, now, local_wall))
            {
                return None;
            }
            Some(task)
        })
        .collect::<Vec<_>>();
    candidates.push(candidate.clone());
    let has_order = candidates.iter().any(|task| {
        task.get("order")
            .and_then(Value::as_f64)
            .or_else(|| task.get("orderNum").and_then(Value::as_f64))
            .is_some_and(|value| value.is_finite())
    });
    let mut best_id = None;
    let mut best_schedule = (u8::MAX, PrimitiveDateTime::MAX);
    let mut best_order = f64::INFINITY;
    for task in &candidates {
        let schedule = local_api_focus_schedule_key(task, now, local_wall);
        let order = local_api_focus_order(task, has_order);
        if best_id.is_none()
            || schedule < best_schedule
            || (schedule == best_schedule && order < best_order)
        {
            best_id = task.get("id").and_then(Value::as_str);
            best_schedule = schedule;
            best_order = order;
        }
    }
    best_id == candidate.get("id").and_then(Value::as_str)
}

fn normalize_created_task_focus(
    task: &mut Map<String, Value>,
    data: &Value,
    now: &str,
    local_wall: &dyn Fn(OffsetDateTime) -> Option<PrimitiveDateTime>,
) {
    if task.get("isFocusedToday").and_then(Value::as_bool) != Some(true) {
        task.remove("focusOrder");
        return;
    }
    let now = OffsetDateTime::parse(now, &Rfc3339).unwrap_or_else(|_| OffsetDateTime::now_utc());
    let original_status = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("inbox")
        .to_string();
    let promoted_status = if original_status == "inbox" {
        "next"
    } else {
        original_status.as_str()
    };
    let mut candidate = task.clone();
    candidate.insert(
        "status".to_string(),
        Value::String(promoted_status.to_string()),
    );
    candidate.insert("isFocusedToday".to_string(), Value::Bool(false));
    let future_start = local_api_task_is_future_start(&candidate, now, local_wall);
    let queued =
        promoted_status == "next" && has_non_empty_string(&candidate, "startTime") && future_start;
    let status_is_eligible = promoted_status == "next"
        || (promoted_status != "inbox" && local_api_review_is_due(&candidate, now, local_wall));
    let eligible = status_is_eligible
        && local_api_project_allows_focus(&candidate, data)
        && (!future_start || queued)
        && local_api_focus_candidate_is_sequential_first(&candidate, data, now, local_wall);
    let cap_is_available = queued
        || local_api_focused_task_count(data, now, local_wall) < local_api_focus_task_limit(data);
    if eligible && cap_is_available {
        task.insert(
            "status".to_string(),
            Value::String(promoted_status.to_string()),
        );
        if queued {
            log::info!("Local API Focus star queued for a later local day extra.releaseCheck=v1.3.5/local-api-focus-local-day");
        }
    } else {
        task.insert("isFocusedToday".to_string(), Value::Bool(false));
        task.remove("focusOrder");
    }
}

fn create_task_from_body(
    body: &Map<String, Value>,
    device_id: &str,
    data: &Value,
) -> Result<Map<String, Value>, String> {
    let unsupported = body
        .keys()
        .filter(|key| !matches!(key.as_str(), "input" | "title" | "props"))
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported.is_empty() {
        return Err(format!(
            "Unsupported task creation fields: {}",
            unsupported.join(", ")
        ));
    }
    for key in ["input", "title"] {
        if body.get(key).is_some_and(|value| !value.is_string()) {
            return Err(format!("Invalid task {key}"));
        }
    }
    let input = body
        .get("input")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    let title = body
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    let resolved_title = if title.is_empty() { input } else { title };
    if resolved_title.is_empty() {
        return Err("Task title is required".to_string());
    }
    if js_string_length(resolved_title) > MAX_TASK_TITLE_LENGTH {
        return Err(format!(
            "Task title too long (max {MAX_TASK_TITLE_LENGTH} characters)"
        ));
    }

    let mut task = match body.get("props") {
        Some(Value::Object(props)) => props.clone(),
        Some(_) => return Err("Invalid task props".to_string()),
        None => Map::new(),
    };
    if task.contains_key("title") {
        return Err("Unsupported task props: title".to_string());
    }
    sanitize_task_patch_map(&mut task)?;
    task.retain(|_, value| !value.is_null());
    if task.get("reminderPolicy").is_none_or(Value::is_null)
        && !task.contains_key("suppressMindwtrReminders")
    {
        task.insert("reminderPolicy".to_string(), json!("inherit"));
    }
    normalize_task_reminder_patch(
        &mut task,
        data.pointer("/settings/taskReminderDefault")
            .and_then(Value::as_str)
            == Some("skip"),
    );
    normalize_created_task_containers(&mut task, &LiveContainers::from_data(data))?;
    let had_explicit_status = task.contains_key("status");
    let now = now_iso();
    task.insert("id".to_string(), Value::String(generate_uuid_v4()));
    task.insert(
        "title".to_string(),
        Value::String(resolved_title.to_string()),
    );
    task.entry("status".to_string())
        .or_insert_with(|| Value::String("inbox".to_string()));
    task.entry("tags".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    task.entry("contexts".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    task.entry("taskMode".to_string())
        .or_insert_with(|| Value::String("task".to_string()));
    task.entry("pushCount".to_string())
        .or_insert_with(|| Value::Number(0.into()));
    task.insert("createdAt".to_string(), Value::String(now.clone()));
    task.insert("updatedAt".to_string(), Value::String(now.clone()));
    if !had_explicit_status && has_non_empty_string(&task, "startTime") {
        task.insert("status".to_string(), Value::String("next".to_string()));
    }
    if !had_explicit_status && has_non_empty_string(&task, "cancelledAt") {
        task.insert("status".to_string(), Value::String("archived".to_string()));
    }
    normalize_local_task_lifecycle(&mut task, &now, None);
    if task.get("status").and_then(Value::as_str) == Some("reference") {
        normalize_created_reference_task(&mut task);
    }
    normalize_created_task_focus(&mut task, data, &now, &crate::local_query::local_wall);
    task.insert("rev".to_string(), Value::Number(1.into()));
    task.insert("revBy".to_string(), Value::String(device_id.to_string()));
    Ok(task)
}

pub(crate) fn apply_task_patch(
    task: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    device_id: &str,
) -> Result<(), String> {
    apply_task_patch_internal(task, patch, device_id, None, false)
}

fn apply_task_patch_with_containers(
    task: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    device_id: &str,
    live_containers: &LiveContainers,
    default_skip: bool,
) -> Result<(), String> {
    apply_task_patch_internal(task, patch, device_id, Some(live_containers), default_skip)
}

fn apply_task_patch_internal(
    task: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    device_id: &str,
    live_containers: Option<&LiveContainers>,
    default_skip: bool,
) -> Result<(), String> {
    let previous_status = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("inbox")
        .to_string();
    let requested_status = if let Some(status) = patch.get("status") {
        let status = status
            .as_str()
            .ok_or_else(|| "Invalid task field: status".to_string())?;
        if matches!(status, "done" | "archived") {
            return Err(
                "Invalid task field: status; use POST /tasks/:id/complete or /archive for terminal transitions"
                    .to_string(),
            );
        }
        if !is_non_terminal_task_status(status) {
            return Err(format!("Invalid task field: status ({status})"));
        }
        if patch.get("cancelledAt").is_some_and(|value| {
            value
                .as_str()
                .is_some_and(|timestamp| !timestamp.trim().is_empty())
        }) {
            return Err(
                "Invalid task field: cancelledAt cannot be combined with a non-terminal status"
                    .to_string(),
            );
        }
        if has_non_empty_string(task, "purgedAt") {
            return Err("Task status conflict: purged task cannot be triaged".to_string());
        }
        if has_non_empty_string(task, "deletedAt") {
            return Err(
                "Task status conflict: use POST /tasks/:id/restore before changing status"
                    .to_string(),
            );
        }
        if matches!(previous_status.as_str(), "done" | "archived") {
            return Err(format!(
                "Task status conflict: {previous_status} task must be reopened in the app before triage"
            ));
        }
        Some(status.to_string())
    } else {
        None
    };
    let mut sanitized = patch.clone();
    sanitize_task_patch_map(&mut sanitized)?;
    normalize_task_reminder_patch(&mut sanitized, default_skip);
    let explicit_order = if sanitized.contains_key("order") {
        sanitized.get("order").cloned()
    } else {
        sanitized.get("orderNum").cloned()
    };
    if let Some(order) = explicit_order {
        sanitized.insert("order".to_string(), order.clone());
        sanitized.insert("orderNum".to_string(), order);
    }
    if let Some(live_containers) = live_containers {
        normalize_task_container_patch(task, &mut sanitized, live_containers)?;
        if requested_status
            .as_deref()
            .is_some_and(|status| status != "reference")
        {
            reject_actionable_task_in_archived_project(task, &sanitized, live_containers)?;
        }
    }
    resolve_relative_start_patch(task, &mut sanitized);
    let series_id = task
        .get("recurrence")
        .and_then(Value::as_object)
        .and_then(|recurrence| recurrence.get("seriesId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| task.get("id").and_then(Value::as_str))
        .map(str::to_string);
    if let (Some(series_id), Some(recurrence)) = (series_id, sanitized.get_mut("recurrence")) {
        match recurrence {
            Value::Object(value) => {
                let has_series_id = value
                    .get("seriesId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty());
                if !has_series_id {
                    value.insert("seriesId".to_string(), Value::String(series_id));
                }
            }
            Value::String(rule) if is_recurrence_rule(rule) => {
                *recurrence = json!({ "rule": rule.clone(), "seriesId": series_id });
            }
            _ => {}
        }
    }
    if let Some(requested_status) = requested_status {
        normalize_task_triage_patch(
            task,
            patch,
            &mut sanitized,
            &previous_status,
            &requested_status,
        );
    }
    let cancelling = has_non_empty_string(&sanitized, "cancelledAt");
    for (key, value) in sanitized {
        if value.is_null() {
            task.remove(&key);
        } else {
            task.insert(key, value);
        }
    }
    let now = now_iso();
    if cancelling {
        task.insert("status".to_string(), Value::String("archived".to_string()));
        task.remove("boardOrder");
    }
    normalize_local_task_lifecycle(task, &now, Some(&previous_status));
    task.insert("updatedAt".to_string(), Value::String(now));
    bump_task_revision(task, device_id);
    Ok(())
}

fn normalize_task_triage_patch(
    task: &Map<String, Value>,
    original_patch: &Map<String, Value>,
    sanitized: &mut Map<String, Value>,
    previous_status: &str,
    requested_status: &str,
) {
    let old_focused = task.get("isFocusedToday").and_then(Value::as_bool) == Some(true);
    let star_turning_on =
        sanitized.get("isFocusedToday").and_then(Value::as_bool) == Some(true) && !old_focused;
    if requested_status == "inbox" && requested_status != previous_status {
        if star_turning_on {
            sanitized.insert("status".to_string(), Value::String("next".to_string()));
        } else {
            let resolved_focused = sanitized
                .get("isFocusedToday")
                .and_then(Value::as_bool)
                .unwrap_or(old_focused);
            if resolved_focused {
                sanitized.insert("isFocusedToday".to_string(), Value::Bool(false));
            }
        }
    }

    let final_status = sanitized
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(requested_status)
        .to_string();
    if final_status != previous_status && !original_patch.contains_key("boardOrder") {
        sanitized.insert("boardOrder".to_string(), Value::Null);
    }

    if final_status == "reference" {
        for field in [
            "startTime",
            "dueDate",
            "relativeStartOffset",
            "reviewAt",
            "recurrence",
            "priority",
            "timeEstimate",
            "suppressMindwtrReminders",
            "repeatReminderMinutes",
            "showFutureRecurrence",
            "focusOrder",
            "boardOrder",
        ] {
            sanitized.insert(field.to_string(), Value::Null);
        }
        sanitized.insert("isFocusedToday".to_string(), Value::Bool(false));
        sanitized.insert("pushCount".to_string(), Value::Number(0.into()));
    }

    let resolved_focused = sanitized
        .get("isFocusedToday")
        .and_then(Value::as_bool)
        .unwrap_or(old_focused);
    if old_focused && !resolved_focused && !original_patch.contains_key("focusOrder") {
        sanitized.insert("focusOrder".to_string(), Value::Null);
    }
}

fn normalize_task_reminder_patch(patch: &mut Map<String, Value>, default_skip: bool) {
    if let Some(policy) = patch.get("reminderPolicy").and_then(Value::as_str) {
        let skip = policy == "skip" || (policy == "inherit" && default_skip);
        patch.insert("suppressMindwtrReminders".to_string(), Value::Bool(skip));
    } else if patch.contains_key("reminderPolicy") {
        patch.remove("reminderPolicy");
    } else if let Some(skip) = patch
        .get("suppressMindwtrReminders")
        .and_then(Value::as_bool)
    {
        patch.insert(
            "reminderPolicy".to_string(),
            json!(if skip { "skip" } else { "send" }),
        );
    }
}

pub(crate) fn sanitize_task_patch_map(patch: &mut Map<String, Value>) -> Result<(), String> {
    for key in ["tags", "contexts"] {
        if let Some(items) = patch.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                if let Some(token) = item.as_str() {
                    *item = Value::String(token.trim().to_string());
                }
            }
        }
    }
    if let Some(items) = patch.get_mut("checklist").and_then(Value::as_array_mut) {
        for item in items {
            if let Some(item) = item.as_object_mut() {
                item.entry("isCompleted".to_string())
                    .or_insert(Value::Bool(false));
            }
        }
    }

    for (key, value) in patch.iter() {
        let valid = match key.as_str() {
            "title" => value.as_str().is_some_and(|title| {
                !title.trim().is_empty() && js_string_length(title) <= MAX_TASK_TITLE_LENGTH
            }),
            "status" => value
                .as_str()
                .is_some_and(|status| validate_task_status(status).is_ok()),
            "tags" | "contexts" => value.as_array().is_some_and(|items| {
                items.iter().all(|item| {
                    item.as_str().is_some_and(|token| {
                        !token.is_empty() && js_string_length(token) <= MAX_TASK_TOKEN_LENGTH
                    })
                })
            }),
            "priority" => {
                value.is_null()
                    || value
                        .as_str()
                        .is_some_and(|item| matches!(item, "low" | "medium" | "high" | "urgent"))
            }
            "energyLevel" => {
                value.is_null()
                    || value
                        .as_str()
                        .is_some_and(|item| matches!(item, "low" | "medium" | "high"))
            }
            "taskMode" => {
                value.is_null()
                    || value
                        .as_str()
                        .is_some_and(|item| matches!(item, "task" | "list"))
            }
            "reminderPolicy" => {
                value.is_null()
                    || value
                        .as_str()
                        .is_some_and(|policy| matches!(policy, "inherit" | "send" | "skip"))
            }
            "textDirection" => {
                value.is_null()
                    || value
                        .as_str()
                        .is_some_and(|item| matches!(item, "auto" | "ltr" | "rtl"))
            }
            "assignedTo" | "description" | "location" | "projectId" | "sectionId" | "areaId" => {
                value.is_null() || value.is_string()
            }
            "startTime" | "dueDate" | "reviewAt" => {
                value.is_null() || value.as_str().is_some_and(valid_iso_date_like)
            }
            "cancelledAt" => {
                value.is_null()
                    || value.as_str().is_some_and(|timestamp| {
                        timestamp.as_bytes().get(10) == Some(&b'T')
                            && OffsetDateTime::parse(timestamp, &Rfc3339).is_ok()
                    })
            }
            "timeEstimate" => value.is_null() || valid_time_estimate(value),
            "showFutureRecurrence" | "isFocusedToday" | "suppressMindwtrReminders" => {
                value.is_boolean()
            }
            "pushCount" | "timeSpentMinutes" => {
                value.is_null() || value.as_i64().is_some_and(|number| number >= 0)
            }
            "repeatReminderMinutes" => {
                value.is_null()
                    || value
                        .as_i64()
                        .is_some_and(|minutes| matches!(minutes, 0 | 5 | 10 | 15 | 30 | 60))
            }
            "order" | "orderNum" | "boardOrder" | "focusOrder" => {
                value.is_null() || valid_finite_integer(value)
            }
            "checklist" => value.is_null() || valid_checklist(value),
            "attachments" => value.is_null() || valid_attachments(value),
            "relativeStartOffset" => value.is_null() || valid_relative_start_offset(value),
            "recurrence" => value.is_null() || valid_recurrence(value),
            // Presentational grouping per view (#1090). Keys are view scopes and
            // values are section ids from the settings catalogue; this engine
            // never resolves them, so it only checks the shape.
            "viewSectionIds" => value.is_null() || valid_view_section_ids(value),
            _ => return Err(format!("Unsupported task field: {key}")),
        };
        if !valid {
            return Err(format!("Invalid task field: {key}"));
        }
    }
    Ok(())
}

fn valid_view_section_ids(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    map.values()
        .all(|entry| entry.as_str().is_some_and(|id| !id.trim().is_empty()))
}

fn js_string_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn valid_finite_integer(value: &Value) -> bool {
    value.as_i64().is_some()
        || value.as_u64().is_some()
        || value
            .as_f64()
            .is_some_and(|number| number.is_finite() && number.fract() == 0.0)
}

fn valid_time_estimate(value: &Value) -> bool {
    let Some(estimate) = value.as_str() else {
        return false;
    };
    if matches!(
        estimate,
        "5min" | "10min" | "15min" | "30min" | "1hr" | "2hr" | "3hr" | "4hr" | "4hr+"
    ) {
        return true;
    }
    estimate
        .strip_prefix("custom:")
        .and_then(|minutes| minutes.parse::<f64>().ok())
        .is_some_and(|minutes| minutes.is_finite() && minutes >= 1.0)
}

fn valid_relative_start_offset(value: &Value) -> bool {
    let Some(offset) = value.as_object() else {
        return false;
    };
    offset.len() == 2
        && offset
            .get("amount")
            .and_then(Value::as_i64)
            .is_some_and(|amount| (-10_000..=0).contains(&amount))
        && offset
            .get("unit")
            .and_then(Value::as_str)
            .is_some_and(|unit| matches!(unit, "minute" | "hour" | "day" | "week"))
}

fn resolve_relative_start_patch(task: &Map<String, Value>, patch: &mut Map<String, Value>) {
    let has_due_date = patch.contains_key("dueDate");
    let has_start_time = patch.contains_key("startTime");
    let has_offset = patch.contains_key("relativeStartOffset");
    if !has_due_date && !has_start_time && !has_offset {
        return;
    }

    let next_due_date = if has_due_date {
        patch.get("dueDate").and_then(Value::as_str)
    } else {
        task.get("dueDate").and_then(Value::as_str)
    };
    let meaningful_start_edit = has_start_time
        && patch.get("startTime").and_then(Value::as_str)
            != task.get("startTime").and_then(Value::as_str);

    if has_offset {
        let computed = patch
            .get("relativeStartOffset")
            .filter(|offset| valid_relative_start_offset(offset))
            .zip(next_due_date)
            .and_then(|(offset, due_date)| compute_relative_start_time(due_date, offset));
        if let Some(start_time) = computed {
            patch.insert("startTime".to_string(), Value::String(start_time));
        } else {
            patch.insert("relativeStartOffset".to_string(), Value::Null);
        }
        return;
    }

    if meaningful_start_edit {
        patch.insert("relativeStartOffset".to_string(), Value::Null);
        return;
    }

    let existing_offset = task
        .get("relativeStartOffset")
        .filter(|offset| valid_relative_start_offset(offset));
    if has_due_date {
        if let Some((offset, start_time)) =
            existing_offset
                .zip(next_due_date)
                .and_then(|(offset, due_date)| {
                    compute_relative_start_time(due_date, offset)
                        .map(|start_time| (offset.clone(), start_time))
                })
        {
            patch.insert("startTime".to_string(), Value::String(start_time));
            patch.insert("relativeStartOffset".to_string(), offset);
        } else if existing_offset.is_some() {
            patch.insert("relativeStartOffset".to_string(), Value::Null);
        }
    }
}

fn compute_relative_start_time(due_date: &str, offset: &Value) -> Option<String> {
    let offset = offset.as_object()?;
    let amount = offset.get("amount")?.as_i64()?;
    let unit = offset.get("unit")?.as_str()?;
    if let Some(date) = parse_iso_date_bytes(due_date.as_bytes()) {
        let days = match unit {
            "day" => amount,
            "week" => amount.checked_mul(7)?,
            _ => return None,
        };
        let computed = date.checked_add(time::Duration::days(days))?;
        if !(0..=9999).contains(&computed.year()) {
            return None;
        }
        return Some(format!(
            "{:04}-{:02}-{:02}",
            computed.year(),
            u8::from(computed.month()),
            computed.day()
        ));
    }

    let due = OffsetDateTime::parse(due_date, &Rfc3339).ok()?;
    let duration = match unit {
        "minute" => time::Duration::minutes(amount),
        "hour" => time::Duration::hours(amount),
        "day" => time::Duration::days(amount),
        "week" => time::Duration::days(amount.checked_mul(7)?),
        _ => return None,
    };
    let computed = due.checked_add(duration)?.to_offset(time::UtcOffset::UTC);
    if !(0..=9999).contains(&computed.year()) {
        return None;
    }
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        computed.year(),
        u8::from(computed.month()),
        computed.day(),
        computed.hour(),
        computed.minute(),
        computed.second(),
        computed.millisecond()
    ))
}

pub(crate) fn valid_iso_date_like(value: &str) -> bool {
    valid_iso_date(value) || valid_iso_datetime(value, true)
}

fn valid_iso_date(value: &str) -> bool {
    parse_iso_date_bytes(value.as_bytes()).is_some()
}

fn parse_iso_date_bytes(bytes: &[u8]) -> Option<Date> {
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let year = decimal_bytes(&bytes[..4]) as i32;
    let month = decimal_bytes(&bytes[5..7]) as u8;
    let day = decimal_bytes(&bytes[8..]) as u8;
    Date::from_calendar_date(year, Month::try_from(month).ok()?, day).ok()
}

fn decimal_bytes(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .fold(0, |value, byte| value * 10 + u32::from(byte - b'0'))
}

fn valid_iso_datetime(value: &str, timezone_required: bool) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 19
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || parse_iso_date_bytes(&bytes[..10]).is_none()
        || !bytes[11..13].iter().all(u8::is_ascii_digit)
        || !bytes[14..16].iter().all(u8::is_ascii_digit)
        || !bytes[17..19].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    let hour = decimal_bytes(&bytes[11..13]);
    let minute = decimal_bytes(&bytes[14..16]);
    let second = decimal_bytes(&bytes[17..19]);
    if hour > 23 || minute > 59 || second > 59 {
        return false;
    }

    let mut index = 19;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if !(1..=3).contains(&(index - fraction_start)) {
            return false;
        }
    }

    if index == bytes.len() {
        return !timezone_required;
    }
    let timezone_valid = bytes[index..] == *b"Z"
        || (bytes.len() == index + 6
            && matches!(bytes[index], b'+' | b'-')
            && bytes[index + 3] == b':'
            && bytes[index + 1..index + 3].iter().all(u8::is_ascii_digit)
            && bytes[index + 4..].iter().all(u8::is_ascii_digit));
    timezone_valid && OffsetDateTime::parse(value, &Rfc3339).is_ok()
}

#[derive(Debug, Default, PartialEq, Eq)]
struct RecurrenceSchedule {
    rule: String,
    by_day: Vec<String>,
    by_month_day: Vec<i64>,
    week_start: Option<String>,
    count: Option<i64>,
    until: Option<String>,
}

pub(crate) fn normalize_mcp_recurrence(value: &Value) -> Result<Value, String> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let result = if let Some(rrule) = value.as_str() {
        let parsed = parse_supported_rrule(rrule).ok_or("Invalid task recurrence")?;
        let mut recurrence = json!({"rule": parsed.rule, "rrule":rrule.trim()})
            .as_object()
            .unwrap()
            .clone();
        if !parsed.by_day.is_empty() {
            recurrence.insert("byDay".into(), json!(parsed.by_day));
        }
        if !parsed.by_month_day.is_empty() {
            recurrence.insert("byMonthDay".into(), json!(parsed.by_month_day));
        }
        if let Some(value) = parsed.week_start {
            recurrence.insert("weekStart".into(), json!(value));
        }
        if let Some(value) = parsed.count {
            recurrence.insert("count".into(), json!(value));
        }
        if let Some(value) = parsed.until {
            recurrence.insert("until".into(), json!(value));
        }
        if let Some(series) = rrule.split(';').find_map(|token| {
            token
                .split_once('=')
                .filter(|(key, _)| key.eq_ignore_ascii_case("X-MINDWTR-SERIES-ID"))
                .map(|(_, value)| value)
        }) {
            recurrence.insert("seriesId".into(), json!(series));
        }
        Value::Object(recurrence)
    } else {
        value.clone()
    };
    if !result.is_object() || !valid_recurrence(&result) {
        return Err("Invalid task recurrence".into());
    }
    Ok(result)
}

fn valid_recurrence(value: &Value) -> bool {
    if let Some(rule) = value.as_str() {
        return is_recurrence_rule(rule);
    }
    let Some(recurrence) = value.as_object() else {
        return false;
    };
    recurrence.iter().all(|(key, value)| match key.as_str() {
        "rule" => value.as_str().is_some_and(is_recurrence_rule),
        "seriesId" => value
            .as_str()
            .is_some_and(|item| !item.trim().is_empty() && item.len() <= 500),
        "until" => value.as_str().is_some_and(valid_recurrence_until),
        "rrule" => value.as_str().and_then(parse_supported_rrule).is_some(),
        "strategy" => value
            .as_str()
            .is_some_and(|item| matches!(item, "strict" | "fluid")),
        "byDay" => value.as_array().is_some_and(|items| {
            items
                .iter()
                .all(|item| item.as_str().is_some_and(valid_recurrence_by_day))
        }),
        "byMonthDay" => value.as_array().is_some_and(|items| {
            items.len() <= 31
                && items
                    .iter()
                    // -1 = RFC 5545 "last day of the month", the one negative
                    // ordinal the core engine supports.
                    .all(|item| {
                        item.as_i64()
                            .is_some_and(|day| (1..=31).contains(&day) || day == -1)
                    })
        }),
        "weekStart" => value.as_str().is_some_and(valid_recurrence_weekday),
        "count" => value.as_i64().is_some_and(|count| count > 0),
        "completedOccurrences" => value.as_i64().is_some_and(|count| count >= 0),
        "anchorDay" | "startAnchorDay" | "dueAnchorDay" | "reviewAnchorDay" => {
            value.as_i64().is_some_and(|day| (1..=31).contains(&day))
        }
        _ => false,
    }) && recurrence_schedule(recurrence).is_some_and(|schedule| {
        compatible_recurrence_schedule(&schedule)
            && recurrence
                .get("rrule")
                .and_then(Value::as_str)
                .is_none_or(|rrule| {
                    parse_supported_rrule(rrule)
                        .is_some_and(|parsed| same_recurrence_schedule(&schedule, &parsed))
                })
    })
}

fn recurrence_schedule(recurrence: &Map<String, Value>) -> Option<RecurrenceSchedule> {
    let parsed = recurrence
        .get("rrule")
        .and_then(Value::as_str)
        .and_then(parse_supported_rrule);
    let mut by_day = recurrence
        .get("byDay")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if by_day.is_empty() {
        by_day = parsed
            .as_ref()
            .map(|schedule| schedule.by_day.clone())
            .unwrap_or_default();
    }
    by_day.sort();
    by_day.dedup();

    let mut by_month_day = recurrence
        .get("byMonthDay")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_i64).collect::<Vec<_>>())
        .unwrap_or_default();
    if by_month_day.is_empty() {
        by_month_day = parsed
            .as_ref()
            .map(|schedule| schedule.by_month_day.clone())
            .unwrap_or_default();
    }
    by_month_day.sort_unstable();
    by_month_day.dedup();

    Some(RecurrenceSchedule {
        rule: recurrence.get("rule")?.as_str()?.to_string(),
        by_day,
        by_month_day,
        week_start: recurrence
            .get("weekStart")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                parsed
                    .as_ref()
                    .and_then(|schedule| schedule.week_start.clone())
            }),
        count: recurrence
            .get("count")
            .and_then(Value::as_i64)
            .or_else(|| parsed.as_ref().and_then(|schedule| schedule.count)),
        until: recurrence
            .get("until")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| parsed.as_ref().and_then(|schedule| schedule.until.clone())),
    })
}

fn compatible_recurrence_schedule(schedule: &RecurrenceSchedule) -> bool {
    match schedule.rule.as_str() {
        "weekly" => {
            schedule.by_month_day.is_empty()
                && schedule
                    .by_day
                    .iter()
                    .all(|day| valid_recurrence_weekday(day))
        }
        "monthly" => {
            schedule.week_start.is_none()
                && (schedule.by_day.is_empty() || schedule.by_month_day.is_empty())
                && schedule
                    .by_day
                    .iter()
                    .all(|day| valid_ordinal_recurrence_weekday(day))
        }
        "daily" | "yearly" => {
            schedule.by_day.is_empty()
                && schedule.by_month_day.is_empty()
                && schedule.week_start.is_none()
        }
        _ => false,
    }
}

fn same_recurrence_schedule(left: &RecurrenceSchedule, right: &RecurrenceSchedule) -> bool {
    left.rule == right.rule
        && left.by_day == right.by_day
        && left.by_month_day == right.by_month_day
        && left.week_start == right.week_start
        && left.count == right.count
        && same_recurrence_until(left.until.as_deref(), right.until.as_deref())
}

fn same_recurrence_until(left: Option<&str>, right: Option<&str>) -> bool {
    if left == right {
        return true;
    }
    let (Some(left), Some(right)) = (left, right) else {
        return false;
    };
    let (Ok(left), Ok(right)) = (
        OffsetDateTime::parse(left, &Rfc3339),
        OffsetDateTime::parse(right, &Rfc3339),
    ) else {
        return false;
    };
    left.unix_timestamp_nanos() == right.unix_timestamp_nanos()
}

fn parse_supported_rrule(value: &str) -> Option<RecurrenceSchedule> {
    let value = value.trim();
    if value.is_empty() || value.len() > 2_000 {
        return None;
    }
    let mut seen = HashSet::new();
    let mut schedule = RecurrenceSchedule::default();
    for token in value.split(';') {
        if token.matches('=').count() != 1 {
            return None;
        }
        let (key, raw) = token.split_once('=')?;
        if key.is_empty() || raw.is_empty() {
            return None;
        }
        let key = key.to_ascii_uppercase();
        if !seen.insert(key.clone()) {
            return None;
        }
        match key.as_str() {
            "FREQ" => {
                schedule.rule = match raw.to_ascii_uppercase().as_str() {
                    "DAILY" => "daily",
                    "WEEKLY" => "weekly",
                    "MONTHLY" => "monthly",
                    "YEARLY" => "yearly",
                    _ => return None,
                }
                .to_string();
            }
            "INTERVAL" => {
                let interval = parse_positive_integer(raw)?;
                if interval > 999 {
                    return None;
                }
            }
            "BYDAY" => {
                let mut days = raw
                    .split(',')
                    .map(str::to_ascii_uppercase)
                    .collect::<Vec<_>>();
                if days.iter().any(|day| !valid_recurrence_by_day(day)) {
                    return None;
                }
                days.sort();
                days.dedup();
                schedule.by_day = days;
            }
            "BYMONTHDAY" => {
                let mut days = raw
                    .split(',')
                    .map(|token| token.trim().parse::<i64>().ok())
                    .collect::<Option<Vec<_>>>()?;
                // -1 = RFC 5545 "last day of the month"; other values keep the
                // positive 1..=31 contract.
                if days.iter().any(|day| !(1..=31).contains(day) && *day != -1) {
                    return None;
                }
                days.sort_unstable();
                days.dedup();
                schedule.by_month_day = days;
            }
            "WKST" => {
                let weekday = raw.to_ascii_uppercase();
                if !valid_recurrence_weekday(&weekday) {
                    return None;
                }
                schedule.week_start = Some(weekday);
            }
            "COUNT" => schedule.count = Some(parse_positive_integer(raw)?),
            "UNTIL" => schedule.until = Some(parse_rrule_until(raw)?),
            "X-MINDWTR-SERIES-ID" => {}
            _ => return None,
        }
    }
    if schedule.rule.is_empty() || !compatible_recurrence_schedule(&schedule) {
        return None;
    }
    Some(schedule)
}

fn parse_positive_integer(value: &str) -> Option<i64> {
    if value.starts_with('0') || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|value| (1..=9_007_199_254_740_991).contains(value))
}

fn parse_rrule_until(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() == 8 && bytes.iter().all(u8::is_ascii_digit) {
        let canonical = format!("{}-{}-{}", &value[..4], &value[4..6], &value[6..]);
        return valid_iso_date(&canonical).then_some(canonical);
    }
    if !matches!(bytes.len(), 13..=16)
        || !bytes[..8].iter().all(u8::is_ascii_digit)
        || !bytes[8].eq_ignore_ascii_case(&b'T')
        || !bytes[9..13].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let has_utc = bytes
        .last()
        .is_some_and(|byte| byte.eq_ignore_ascii_case(&b'Z'));
    let value_end = bytes.len() - usize::from(has_utc);
    let second = match value_end {
        13 => "00",
        15 if bytes[13..15].iter().all(u8::is_ascii_digit) => &value[13..15],
        _ => return None,
    };
    let canonical = format!(
        "{}-{}-{}T{}:{}:{}{}",
        &value[..4],
        &value[4..6],
        &value[6..8],
        &value[9..11],
        &value[11..13],
        second,
        if has_utc { "Z" } else { "" }
    );
    valid_recurrence_until(&canonical).then_some(canonical)
}

fn valid_recurrence_until(value: &str) -> bool {
    valid_iso_date(value) || valid_iso_datetime(value, false)
}

fn valid_recurrence_weekday(value: &str) -> bool {
    matches!(value, "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")
}

fn valid_recurrence_by_day(value: &str) -> bool {
    valid_recurrence_weekday(value)
        || ["1", "2", "3", "4", "-1"].iter().any(|prefix| {
            value
                .strip_prefix(prefix)
                .is_some_and(valid_recurrence_weekday)
        })
}

fn valid_ordinal_recurrence_weekday(value: &str) -> bool {
    ["1", "2", "3", "4", "-1"].iter().any(|prefix| {
        value
            .strip_prefix(prefix)
            .is_some_and(valid_recurrence_weekday)
    })
}

fn valid_checklist(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.iter().all(|item| {
            let Some(item) = item.as_object() else {
                return false;
            };
            item.len() == 3
                && item
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.trim().is_empty())
                && item
                    .get("title")
                    .and_then(Value::as_str)
                    .is_some_and(|title| !title.trim().is_empty())
                && item.get("isCompleted").is_some_and(Value::is_boolean)
        })
    })
}

/// Mirrors `ATTACHMENT_CLOUD_KEY_PATTERN` in packages/core/src/sync-normalization.ts. The local
/// HTTP API is a second write path into the same attachments, so a cloudKey accepted here must be
/// one the sync merge would accept too — the pattern is what rules out separators, traversal
/// segments and NUL bytes reaching a filesystem or remote path.
fn valid_attachment_cloud_key(value: &str) -> bool {
    fn valid_name(name: &str) -> bool {
        let mut chars = name.chars();
        chars
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
            && chars.all(|item| item.is_ascii_alphanumeric() || item == '_' || item == '-')
    }

    if let Some(record_id) = value.strip_prefix("cloudkit:") {
        return valid_name(record_id);
    }
    let Some(name) = value.strip_prefix("attachments/") else {
        return false;
    };
    let (stem, extension) = match name.split_once('.') {
        Some((stem, extension)) => (stem, Some(extension)),
        None => (name, None),
    };
    if !valid_name(stem) {
        return false;
    }
    let Some(extension) = extension else {
        return true;
    };
    let mut chars = extension.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && extension.chars().count() <= 128
        && chars
            .all(|item| item.is_ascii_alphanumeric() || item == '.' || item == '_' || item == '-')
}

fn valid_attachments(value: &Value) -> bool {
    value.as_array().is_some_and(|attachments| {
        attachments.iter().all(|attachment| {
            let Some(attachment) = attachment.as_object() else {
                return false;
            };
            attachment.iter().all(|(key, value)| match key.as_str() {
                "id" | "title" | "uri" | "createdAt" | "updatedAt" => {
                    value.as_str().is_some_and(|item| !item.trim().is_empty())
                }
                "kind" => value
                    .as_str()
                    .is_some_and(|kind| matches!(kind, "file" | "link")),
                "mimeType" | "deletedAt" | "fileHash" | "staleContentHash" => value.is_string(),
                // Device-local sync state a GET returns, so a GET-edit-PATCH round trip carries it back unchanged.
                "pendingContentUpload" => value.is_boolean(),
                "cloudKey" => value.as_str().is_some_and(valid_attachment_cloud_key),
                "size" | "contentRev" | "contentMtimeMs" | "contentSize" => {
                    value.as_u64().is_some()
                }
                "localStatus" => value.as_str().is_some_and(|status| {
                    matches!(
                        status,
                        "available" | "missing" | "uploading" | "downloading"
                    )
                }),
                _ => false,
            }) && ["id", "kind", "title", "uri", "createdAt", "updatedAt"]
                .iter()
                .all(|key| attachment.contains_key(*key))
        })
    })
}

fn validate_task_status(status: &str) -> Result<(), String> {
    match status {
        "inbox" | "next" | "waiting" | "someday" | "reference" | "done" | "archived" => Ok(()),
        _ => Err(format!("Invalid status: {status}")),
    }
}

pub(crate) fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hi = bytes.get(index + 1).and_then(|value| hex_value(*value))?;
            let lo = bytes.get(index + 2).and_then(|value| hex_value(*value))?;
            decoded.push((hi << 4) | lo);
            index += 3;
        } else if bytes[index] == b'+' {
            decoded.push(b' ');
            index += 1;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reminder_policy_create_and_patch_preserve_legacy_intent_and_inherit_default() {
        let data = json!({"tasks": [], "projects": [], "sections": [], "areas": [],
            "settings": {"taskReminderDefault": "skip"}});
        for (props, expected, skip) in [
            (json!({}), "inherit", true),
            (json!({"suppressMindwtrReminders": false}), "send", false),
            (json!({"suppressMindwtrReminders": true}), "skip", true),
            (
                json!({"reminderPolicy": "send", "suppressMindwtrReminders": true}),
                "send",
                false,
            ),
        ] {
            let body = json!({"title": "Reminder policy", "props": props});
            let mut task =
                create_task_from_body(body.as_object().unwrap(), "device-a", &data).unwrap();
            assert_eq!(task["reminderPolicy"], expected);
            assert_eq!(task["suppressMindwtrReminders"], skip);
            let patch = json!({"title": "Unrelated edit"});
            apply_task_patch(&mut task, patch.as_object().unwrap(), "device-a").unwrap();
            assert_eq!(task["reminderPolicy"], expected);
            assert_eq!(task["suppressMindwtrReminders"], skip);
        }
        let mut data = json!({"tasks": [{"id":"policy", "title":"Policy", "status":"next", "reminderPolicy":"send"}],
            "settings":{"taskReminderDefault":"skip"}});
        patch_task_in_data(
            &mut data,
            "policy",
            json!({"reminderPolicy":"inherit"}).as_object().unwrap(),
        )
        .unwrap();
        assert_eq!(data["tasks"][0]["reminderPolicy"], "inherit");
        assert_eq!(data["tasks"][0]["suppressMindwtrReminders"], true);
        patch_task_in_data(
            &mut data,
            "policy",
            json!({"suppressMindwtrReminders":false})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(data["tasks"][0]["reminderPolicy"], "send");
        assert_eq!(data["tasks"][0]["suppressMindwtrReminders"], false);
        let mut legacy = json!({"id":"legacy", "title":"Legacy", "status":"next", "suppressMindwtrReminders":false}).as_object().unwrap().clone();
        apply_task_patch(
            &mut legacy,
            json!({"title":"Retitled"}).as_object().unwrap(),
            "device-a",
        )
        .unwrap();
        assert!(!legacy.contains_key("reminderPolicy"));
        for policy in [json!(true), json!("sometimes"), json!(1)] {
            assert!(sanitize_task_patch_map(
                &mut json!({"reminderPolicy":policy})
                    .as_object()
                    .unwrap()
                    .clone()
            )
            .is_err());
        }
    }

    #[test]
    fn local_api_patch_focus_accepts_past_no_offset_review_for_rest_and_mcp() {
        use crate::storage::{local_operation_test_commit, local_operation_test_seed};
        let data = json!({
            "tasks": [{
                "id": "waiting", "title": "Waiting", "status": "waiting",
                "reviewAt": "2026-10-01T09:00", "isFocusedToday": false, "rev": 1,
                "tags": [], "contexts": [],
                "createdAt": "2026-10-01T08:00:00Z", "updatedAt": "2026-10-01T08:00:00Z"
            }],
            "projects": [], "sections": [], "areas": [], "people": [],
            "settings": {"deviceId": "device-a", "gtd": {"focusTaskLimit": 3}}
        });
        let request = ApiRequest {
            method: "PATCH".into(),
            path: "/tasks/waiting".into(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({"isFocusedToday": true})).unwrap(),
        };
        let rest = operation_from_api_request(&request).unwrap().unwrap();
        let input = json!({"id": "waiting", "isFocusedToday": true});
        let mcp =
            crate::mcp_tools::operation("mindwtr_update_task", input.as_object().unwrap()).unwrap();
        assert_eq!(rest, mcp);
        for operation in [rest, mcp] {
            let mut conn = rusqlite::Connection::open_in_memory().unwrap();
            local_operation_test_seed(&mut conn, &data).unwrap();
            let persisted = local_operation_test_commit(
                &conn,
                TaskMutationReadScope::patch("waiting", None, None, None, true),
                |data| mutate_task_operation(data, &operation),
            )
            .expect("past no-offset review must allow a Focus star below the cap");
            let task = find_task(&persisted, "waiting").unwrap();
            assert_eq!(task["status"], "waiting");
            assert_eq!(task["isFocusedToday"], true);
            assert_eq!(task["reviewAt"], "2026-10-01T09:00");
        }
    }

    #[test]
    fn local_api_b2a_review_focus_uses_local_midnight_and_exact_wall_time() {
        let now = "2026-10-11T23:30:00Z";
        let offset = time::UtcOffset::from_hms(9, 0, 0).unwrap();
        let local_wall = |instant: OffsetDateTime| {
            let local = instant.to_offset(offset);
            Some(PrimitiveDateTime::new(local.date(), local.time()))
        };
        for (review, due) in [
            ("2026-10-12", true),
            ("2026-10-12T08:30", true),
            ("2026-10-12T08:30:00", true),
            ("2026-10-12T08:30+09:00", true),
            ("2026-10-11T23:30:00Z", true),
            ("2026-10-12T08:31", false),
            ("2026-10-13", false),
        ] {
            let mut task = json!({
                "status": "waiting", "reviewAt": review, "isFocusedToday": true
            })
            .as_object()
            .unwrap()
            .clone();
            normalize_created_task_focus(&mut task, &empty_local_api_data(), now, &local_wall);
            assert_eq!(
                task["isFocusedToday"], due,
                "Tokyo review eligibility mismatch: {review}"
            );
            assert_eq!(task["status"], "waiting");
        }
    }

    #[test]
    fn local_api_seqkey_create_start_today_does_not_displace_first_task() {
        let now = "2026-10-11T23:30:00Z";
        let offset = time::UtcOffset::from_hms(9, 0, 0).unwrap();
        let local_wall = |instant: OffsetDateTime| {
            let local = instant.to_offset(offset);
            Some(PrimitiveDateTime::new(local.date(), local.time()))
        };
        let data = json!({
            "tasks": [{
                "id": "first", "status": "next", "projectId": "project", "orderNum": 1
            }],
            "projects": [{"id": "project", "status": "active", "isSequential": true}]
        });
        let mut task = json!({
            "id": "second", "status": "next", "projectId": "project", "orderNum": 2,
            "startTime": "2026-10-12T07:00", "isFocusedToday": true, "focusOrder": 1
        })
        .as_object()
        .unwrap()
        .clone();

        normalize_created_task_focus(&mut task, &data, now, &local_wall);

        assert_eq!(
            task["isFocusedToday"], false,
            "SEQKEY: a start on Tokyo's today must not displace the first sequential task"
        );
        assert_eq!(task["status"], "next");
        assert_eq!(task["startTime"], "2026-10-12T07:00");
        assert!(!task.contains_key("focusOrder"));
    }

    #[test]
    fn local_api_seqkey_waiting_due_does_not_outrank_review() {
        let now = OffsetDateTime::parse("2026-10-11T23:30:00Z", &Rfc3339).unwrap();
        let offset = time::UtcOffset::from_hms(9, 0, 0).unwrap();
        let local_wall = |instant: OffsetDateTime| {
            let local = instant.to_offset(offset);
            Some(PrimitiveDateTime::new(local.date(), local.time()))
        };
        let mut task = json!({
            "status": "waiting", "dueDate": "2026-10-11", "reviewAt": "2026-10-12T08:00"
        })
        .as_object()
        .unwrap()
        .clone();
        let review = local_api_focus_schedule_time(task.get("reviewAt"), &local_wall).unwrap();

        assert_eq!(
            local_api_focus_schedule_key(&task, now, &local_wall),
            (1, review),
            "SEQKEY: waiting tasks must rank by their due review, never their due date"
        );
        task.remove("reviewAt");
        assert_eq!(
            local_api_focus_schedule_key(&task, now, &local_wall),
            (2, PrimitiveDateTime::MAX)
        );
        task.insert("isFocusedToday".into(), Value::Bool(true));
        assert_eq!(
            local_api_focus_schedule_key(&task, now, &local_wall),
            (0, PrimitiveDateTime::MIN)
        );
    }

    #[test]
    fn local_api_b2a_sequential_focus_orders_local_schedule_values() {
        let now = "2026-10-11T23:30:00Z";
        let offset = time::UtcOffset::from_hms(9, 0, 0).unwrap();
        let local_wall = |instant: OffsetDateTime| {
            let local = instant.to_offset(offset);
            Some(PrimitiveDateTime::new(local.date(), local.time()))
        };
        for (field, schedule, focused) in [
            ("startTime", "2026-10-12T07:00", false),
            ("startTime", "2026-10-11T23:00:00Z", false),
            ("dueDate", "2026-10-12", true),
            ("dueDate", "2026-10-12T09:00", true),
            ("dueDate", "2026-10-11T23:00:00Z", true),
            ("dueDate", "2026-10-13", false),
            ("reviewAt", "2026-10-12T08:00", true),
            ("reviewAt", "2026-10-12T08:31", false),
        ] {
            let mut data = json!({
                "tasks": [{
                    "id": "unscheduled", "status": "next", "projectId": "project", "orderNum": 1
                }],
                "projects": [{"id": "project", "status": "active", "isSequential": true}]
            });
            let task = json!({
                "id": "scheduled", "status": "next", "projectId": "project", "orderNum": 2,
                "isFocusedToday": true, field: schedule
            })
            .as_object()
            .unwrap()
            .clone();
            let mut normalized = task.clone();
            normalize_created_task_focus(&mut normalized, &data, now, &local_wall);
            assert_eq!(
                normalized["isFocusedToday"], focused,
                "sequential Focus must match core's local schedule rank: {field}={schedule}"
            );

            data["tasks"][0][field] = json!(schedule);
            let mut normalized = task;
            normalize_created_task_focus(&mut normalized, &data, now, &local_wall);
            assert_eq!(
                normalized["isFocusedToday"], false,
                "equal schedule keys must keep manual sequence order: {field}={schedule}"
            );
        }
    }

    /// Core's Focus admission table (focus-admission-cases.test.ts runs the
    /// same cases against resolveTaskFocusUpdate). A case's patch is the
    /// before -> after difference; refused-limit maps to the exact error,
    /// focused/queued to a saved star, unchanged to a successful patch.
    #[test]
    fn local_api_patch_focus_matches_core_admission_cases() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/__fixtures__/focus-admission/cases.json"
        ))
        .expect("valid Focus admission fixture");
        let defaults = fixture["taskDefaults"].as_object().unwrap();
        let divergences: Vec<&str> = fixture["knownRustDivergences"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let mut mismatches = Vec::new();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let task = |side: &str| {
                let mut task = defaults.clone();
                task.extend(case[side].as_object().unwrap().clone());
                task
            };
            let (before, after) = (task("before"), task("after"));
            let mut patch: Map<String, Value> = after
                .iter()
                .filter(|(key, value)| before.get(*key) != Some(*value))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            for key in before.keys().filter(|key| !after.contains_key(*key)) {
                patch.insert(key.clone(), Value::Null);
            }
            let limit = case["focusTaskLimit"].as_u64().unwrap();
            let mut data = json!({
                "tasks": [Value::Object(before)],
                "projects": [], "sections": [], "areas": [], "people": [],
                "settings": {"deviceId": "device-a", "gtd": {"focusTaskLimit": limit}},
                TASK_MUTATION_FOCUSED_COUNT_KEY: case["focusedCount"].clone(),
            });
            let offset = time::UtcOffset::from_whole_seconds(
                case["utcOffsetMinutes"].as_i64().unwrap() as i32 * 60,
            )
            .unwrap();
            let local_wall = |instant: OffsetDateTime| {
                let local = instant.to_offset(offset);
                Some(PrimitiveDateTime::new(local.date(), local.time()))
            };
            let now = OffsetDateTime::parse(case["now"].as_str().unwrap(), &Rfc3339).unwrap();
            let result = patch_task_in_data_at(&mut data, "task", &patch, now, &local_wall);
            let matches = match case["outcome"].as_str().unwrap() {
                "refused-limit" => result == Err(format!("Focus limit of {limit} reached")),
                "focused" | "queued" => result
                    .as_ref()
                    .is_ok_and(|task| task["isFocusedToday"] == true),
                "unchanged" => result.is_ok(),
                other => panic!("{name}: unknown outcome {other}"),
            };
            // A listed divergence that starts matching must leave the list.
            if matches == divergences.contains(&name) {
                mismatches.push(format!("{name}: {result:?}"));
            }
        }
        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }

    #[test]
    fn local_api_patch_focus_limit_refuses_atomically_for_rest_and_mcp() {
        use crate::storage::{
            local_operation_test_commit, local_operation_test_seed, read_sqlite_data,
        };
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        let data = json!({
            "tasks": (0..4).map(|index| json!({
                "id": format!("task-{index}"), "title": "Original", "status": "next",
                "isFocusedToday": index < 3, "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-10-11T12:00:00Z", "updatedAt": "2026-10-11T12:00:00Z"
            })).collect::<Vec<_>>(),
            "projects": [], "sections": [], "areas": [], "people": [],
            "settings": {"deviceId": "device-a", "gtd": {"focusTaskLimit": 3}}
        });
        local_operation_test_seed(&mut conn, &data).unwrap();
        let before = read_sqlite_data(&conn).unwrap();
        let request = ApiRequest {
            method: "PATCH".into(),
            path: "/tasks/task-3".into(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({"isFocusedToday": true, "title": "Changed"})).unwrap(),
        };
        let rest = operation_from_api_request(&request).unwrap().unwrap();
        let input = json!({"id": "task-3", "isFocusedToday": true, "title": "Changed"});
        let mcp =
            crate::mcp_tools::operation("mindwtr_update_task", input.as_object().unwrap()).unwrap();
        assert_eq!(rest, mcp);
        for operation in [rest, mcp] {
            let result = local_operation_test_commit(
                &conn,
                TaskMutationReadScope::patch("task-3", None, None, None, true),
                |data| mutate_task_operation(data, &operation),
            );
            assert!(
                result.is_err(),
                "PATCH must refuse a fourth Focus star at limit 3"
            );
            let response = api_error_response(result.unwrap_err());
            assert_eq!(response.status, 409);
            assert_eq!(response.body["error"], "Focus limit of 3 reached");
            assert_eq!(read_sqlite_data(&conn).unwrap(), before);
        }
    }

    #[test]
    fn local_api_patch_focus_queued_start_refuses_atomically_with_scoped_count() {
        use crate::storage::{
            local_operation_test_commit, local_operation_test_seed, read_sqlite_data,
        };
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        let mut data = empty_local_api_data();
        data["settings"] = json!({"deviceId": "device-a", "gtd": {"focusTaskLimit": 3}});
        data["tasks"] = json!([
            {"id": "focus-1", "title": "Focus", "status": "next", "isFocusedToday": true},
            {"id": "focus-2", "title": "Focus", "status": "next", "isFocusedToday": true},
            {"id": "focus-3", "title": "Focus", "status": "next", "isFocusedToday": true},
            {"id": "queued", "title": "Queued", "status": "next", "isFocusedToday": true,
             "startTime": "9999-12-31", "rev": 1}
        ]);
        local_operation_test_seed(&mut conn, &data).unwrap();
        let before = read_sqlite_data(&conn).unwrap();
        let now = OffsetDateTime::now_utc();
        let today = crate::local_query::local_wall(now)
            .map(|wall| wall.date())
            .unwrap_or_else(|| now.date())
            .to_string();
        for patch in [json!({"startTime": null}), json!({"startTime": today})] {
            let request = ApiRequest {
                method: "PATCH".into(),
                path: "/tasks/queued".into(),
                query: HashMap::new(),
                headers: HashMap::new(),
                body: serde_json::to_vec(&patch).unwrap(),
            };
            let rest = operation_from_api_request(&request).unwrap().unwrap();
            let mut input = patch.as_object().unwrap().clone();
            input.insert("id".into(), json!("queued"));
            let mcp = crate::mcp_tools::operation("mindwtr_update_task", &input).unwrap();
            assert_eq!(rest, mcp);
            for operation in [rest, mcp] {
                let result = local_operation_test_commit(
                    &conn,
                    task_patch_read_scope("queued", patch.as_object().unwrap()),
                    |data| {
                        assert_eq!(
                            data[TASK_MUTATION_FOCUSED_COUNT_KEY], 3,
                            "queued PATCH must load the global Focus count"
                        );
                        mutate_task_operation(data, &operation)
                    },
                );
                assert_eq!(result, Err("Focus limit of 3 reached".into()));
                assert_eq!(read_sqlite_data(&conn).unwrap(), before);
            }
        }
    }

    #[test]
    fn local_api_patch_focus_limit_keeps_existing_stars_and_queues_local_tomorrow() {
        use crate::storage::{local_operation_test_commit, local_operation_test_seed};
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        let data = json!({
            "tasks": (0..4).map(|index| json!({
                "id": format!("task-{index}"), "title": "Original", "status": "next",
                "isFocusedToday": index < 3, "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-10-11T12:00:00Z", "updatedAt": "2026-10-11T12:00:00Z"
            })).collect::<Vec<_>>(),
            "projects": [], "sections": [], "areas": [], "people": [],
            "settings": {"deviceId": "device-a", "gtd": {"focusTaskLimit": 3}}
        });
        local_operation_test_seed(&mut conn, &data).unwrap();
        let now = OffsetDateTime::now_utc();
        let tomorrow = crate::local_query::local_wall(now)
            .map(|wall| wall.date())
            .unwrap_or_else(|| now.date())
            .next_day()
            .unwrap()
            .to_string();
        for (id, patch) in [
            (
                "task-0",
                json!({"isFocusedToday": true, "title": "Kept star"}),
            ),
            (
                "task-3",
                json!({"isFocusedToday": true, "startTime": tomorrow}),
            ),
        ] {
            let operation = LocalOperation::PatchTask {
                id: id.into(),
                body: patch.as_object().unwrap().clone(),
            };
            let persisted = local_operation_test_commit(
                &conn,
                TaskMutationReadScope::patch(id, None, None, None, true),
                |data| mutate_task_operation(data, &operation),
            )
            .unwrap();
            let task = find_task(&persisted, id).unwrap();
            assert_eq!(task["isFocusedToday"], true);
            assert_eq!(task["status"], "next");
            assert_eq!(
                local_api_focused_task_count(&persisted, now, &crate::local_query::local_wall),
                3
            );
        }
    }

    #[test]
    fn local_api_patch_focus_matches_core_normalization_below_cap() {
        for (status, review, focused) in [
            ("inbox", None, true),
            ("next", None, true),
            ("waiting", Some("2000-01-01"), true),
            ("someday", Some("2000-01-01"), true),
            ("waiting", None, true),
            ("someday", Some("9999-12-31"), true),
            ("reference", Some("2000-01-01"), false),
            ("done", None, false),
            ("archived", None, false),
        ] {
            let mut data = empty_local_api_data();
            data["tasks"] =
                json!([{"id": "task", "title": "Original", "status": status, "reviewAt": review}]);
            let patch = json!({"isFocusedToday": true, "title": "Changed"});
            let task = patch_task_in_data(&mut data, "task", patch.as_object().unwrap())
                .expect("ineligible star below the cap must follow core normalization");
            assert_eq!(task["isFocusedToday"], focused, "{status} {review:?}");
            assert_eq!(
                task["status"],
                if status == "inbox" { "next" } else { status }
            );
            assert_eq!(task["title"], "Changed");
        }
    }

    #[test]
    fn local_api_b2a_patch_normalizes_deferred_stars_like_core() {
        for status in ["waiting", "someday"] {
            for (patch, focused) in [
                (json!({"isFocusedToday": true}), true),
                (
                    json!({"isFocusedToday": true, "startTime": "9999-12-31"}),
                    false,
                ),
            ] {
                let mut data = empty_local_api_data();
                data["tasks"] = json!([{
                    "id": "task", "title": "Deferred", "status": status,
                    "startTime": "9999-12-31", "focusOrder": 1
                }]);
                let task = patch_task_in_data(&mut data, "task", patch.as_object().unwrap())
                    .expect("deferred star patch must follow core normalization");
                assert_eq!(task["isFocusedToday"], focused, "{status} {patch}");
                assert_eq!(task["status"], status);
                assert_eq!(task.get("focusOrder"), Some(&json!(1)));
            }
        }
    }

    #[test]
    fn mcp_shared_http_parser_preserves_http_10_and_rejects_malformed_versions() {
        for version in ["HTTP/1.0", "HTTP/1.1"] {
            let raw = format!("GET /tasks {version}\r\nHost: 127.0.0.1:3456\r\n\r\n");
            let request = read_request(&mut std::io::Cursor::new(raw), far_future_deadline())
                .unwrap()
                .unwrap();
            assert!(matches!(
                operation_from_api_request(&request).unwrap(),
                Some(LocalOperation::ListTasks(_))
            ));
        }
        for version in ["HTTP/1", "HTTP/1.2", "HTTP/2", "http/1.1", "HTTP/1.1 extra"] {
            let raw = format!("GET /tasks {version}\r\n\r\n");
            assert!(
                read_request(&mut std::io::Cursor::new(raw), far_future_deadline()).is_err(),
                "{version}"
            );
        }
    }

    #[test]
    fn mcp_shared_bearer_auth_accepts_case_insensitive_scheme_and_exact_credential() {
        let mut request = ApiRequest {
            method: "GET".into(),
            path: "/tasks".into(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        for authorization in [
            "Bearer CaseSensitiveToken",
            "bearer CaseSensitiveToken",
            "bEaReR\tCaseSensitiveToken",
        ] {
            request
                .headers
                .insert("authorization".into(), authorization.into());
            assert!(is_request_authorized(&request, "CaseSensitiveToken"));
        }
        for authorization in [
            "bearer casesensitivetoken",
            "Bearer",
            "Basic CaseSensitiveToken",
            "Bearer CaseSensitiveToken extra",
        ] {
            request
                .headers
                .insert("authorization".into(), authorization.into());
            assert!(!is_request_authorized(&request, "CaseSensitiveToken"));
        }
    }

    #[test]
    fn mcp_shared_rest_mutations_persist_through_existing_sqlite_transactions() {
        use crate::storage::{
            local_operation_test_commit, local_operation_test_seed, read_sqlite_data,
        };
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shared-native-operations.sqlite");
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        local_operation_test_seed(&mut conn, &empty_local_api_data()).unwrap();
        let input = json!({"title":"Shared task","status":"next","tags":["#fixture"]});
        let request = ApiRequest {
            method: "POST".into(),
            path: "/tasks".into(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: serde_json::to_vec(
                &json!({"title":"Shared task","props":{"status":"next","tags":["#fixture"]}}),
            )
            .unwrap(),
        };
        let rest = operation_from_api_request(&request).unwrap().unwrap();
        let mcp =
            crate::mcp_tools::operation("mindwtr_add_task", input.as_object().unwrap()).unwrap();
        assert_eq!(rest, mcp, "both adapters select the same native operation");
        let persisted = local_operation_test_commit(
            &conn,
            TaskMutationReadScope::create(None, None, None, false),
            |data| mutate_task_operation(data, &mcp),
        )
        .unwrap();
        let id = persisted["tasks"][0]["id"].as_str().unwrap().to_string();
        drop(conn);
        let conn = rusqlite::Connection::open(&path).unwrap();
        let reopened = read_sqlite_data(&conn).unwrap();
        assert_eq!(find_task(&reopened, &id).unwrap()["title"], "Shared task");
        assert_eq!(find_task(&reopened, &id).unwrap()["rev"], 1);
        // Another writer changes the row between requests; the common transaction
        // reloads it before the next REST/MCP patch and preserves that edit.
        let intervening = LocalOperation::PatchTask {
            id: id.clone(),
            body: json!({"description":"Intervening edit"})
                .as_object()
                .unwrap()
                .clone(),
        };
        local_operation_test_commit(
            &conn,
            TaskMutationReadScope::patch(&id, None, None, None, false),
            |data| mutate_task_operation(data, &intervening),
        )
        .unwrap();
        let patch = json!({"id":id,"status":"waiting","tags":null});
        let mcp =
            crate::mcp_tools::operation("mindwtr_update_task", patch.as_object().unwrap()).unwrap();
        let request = ApiRequest {
            method: "PATCH".into(),
            path: format!("/tasks/{id}"),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({"status":"waiting","tags":[]})).unwrap(),
        };
        let rest = operation_from_api_request(&request).unwrap().unwrap();
        assert_eq!(rest, mcp);
        local_operation_test_commit(
            &conn,
            TaskMutationReadScope::patch(&id, None, None, None, false),
            |data| mutate_task_operation(data, &rest),
        )
        .unwrap();
        drop(conn);
        let conn = rusqlite::Connection::open(&path).unwrap();
        let task = find_task(&read_sqlite_data(&conn).unwrap(), &id).unwrap();
        assert_eq!(task["rev"], 3);
        assert_eq!(task["description"], "Intervening edit");
        assert_eq!(task["status"], "waiting");
        assert_eq!(task["tags"], json!([]));
        let complete = crate::mcp_tools::operation(
            "mindwtr_complete_task",
            json!({"id":id}).as_object().unwrap(),
        )
        .unwrap();
        local_operation_test_commit(&conn, TaskMutationReadScope::existing(&id, false), |data| {
            mutate_task_operation(data, &complete)
        })
        .unwrap();
        drop(conn);
        let conn = rusqlite::Connection::open(&path).unwrap();
        let task = find_task(&read_sqlite_data(&conn).unwrap(), &id).unwrap();
        assert_eq!(task["status"], "done");
        assert_eq!(task["rev"], 4);
        let invalid = LocalOperation::PatchTask {
            id: id.clone(),
            body: json!({"status":"next"}).as_object().unwrap().clone(),
        };
        assert!(local_operation_test_commit(
            &conn,
            TaskMutationReadScope::patch(&id, None, None, None, false),
            |data| mutate_task_operation(data, &invalid)
        )
        .is_err());
        assert_eq!(
            find_task(&read_sqlite_data(&conn).unwrap(), &id).unwrap(),
            task,
            "failed operation rolls back atomically"
        );
    }

    #[test]
    fn mcp_archive_permission_preserves_history_and_never_spawns_recurring_tasks() {
        use crate::mcp_server::{handle_mcp_request, McpPermissions};
        use crate::storage::{
            local_operation_test_commit, local_operation_test_seed, read_sqlite_data,
        };
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mcp-archive.sqlite");
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        let mut seed = empty_local_api_data();
        let completed_at = "2026-10-01T12:00:00Z";
        seed["tasks"] = json!([
            {"id":"history", "title":"History", "status":"done", "completedAt":completed_at,
                "recurrence":{"rule":"daily","count":5,"completedOccurrences":2},
                "createdAt":completed_at,"updatedAt":completed_at,"rev":1,"tags":[],"contexts":[]},
            {"id":"recurring", "title":"Recurring", "status":"next",
                "recurrence":{"rule":"daily","count":5,"completedOccurrences":2},
                "createdAt":completed_at,"updatedAt":completed_at,"rev":1,"tags":[],"contexts":[]}
        ]);
        local_operation_test_seed(&mut conn, &seed).unwrap();
        let before = read_sqlite_data(&conn).unwrap();
        let access = LocalApiAccess {
            allow_write: true,
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        for allowed in [false, true] {
            for id in ["history", "recurring"] {
                let request = ApiRequest {
                    method: "POST".into(),
                    path: "/mcp".into(),
                    query: HashMap::new(),
                    headers: HashMap::from([
                        ("host".into(), "127.0.0.1:9123".into()),
                        ("authorization".into(), "Bearer fixture".into()),
                        ("content-type".into(), "application/json".into()),
                        (
                            "accept".into(),
                            "application/json, text/event-stream".into(),
                        ),
                    ]),
                    body: serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                        "params":{"name":"mindwtr_archive_task","arguments":{"id":id}}}))
                    .unwrap(),
                };
                let mut executed = false;
                let response = handle_mcp_request(
                    "fixture",
                    &access,
                    McpPermissions {
                        allow_write: !allowed,
                        allow_archive: allowed,
                        allow_delete: false,
                    },
                    9123,
                    request,
                    |operation| {
                        executed = true;
                        let persisted = local_operation_test_commit(
                            &conn,
                            TaskMutationReadScope::existing(id, false),
                            |data| mutate_task_operation(data, &operation),
                        )?;
                        Ok(json!({"task":find_task(&persisted, id).unwrap()}))
                    },
                );
                assert_eq!(executed, allowed);
                assert_eq!(response.body["result"]["isError"] == true, !allowed);
                if !allowed {
                    assert_eq!(
                        read_sqlite_data(&conn).unwrap(),
                        before,
                        "denial leaves durable rows unchanged"
                    );
                }
            }
        }
        drop(conn);
        let conn = rusqlite::Connection::open(&path).unwrap();
        let reopened = read_sqlite_data(&conn).unwrap();
        assert_eq!(reopened["tasks"].as_array().unwrap().len(), 2);
        for id in ["history", "recurring"] {
            let task = find_task(&reopened, id).unwrap();
            assert_eq!(task["status"], "archived");
            assert_eq!(task["rev"], 2);
            assert_eq!(task["recurrence"]["completedOccurrences"], 2);
            assert!(valid_cancellation_timestamp(task.get("archivedAt")));
        }
        assert_eq!(
            find_task(&reopened, "history").unwrap()["completedAt"],
            completed_at
        );
    }

    #[test]
    fn local_operation_auth_and_read_only_block_mutations_before_storage() {
        let access = LocalApiAccess {
            allow_write: false,
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let mut request = ApiRequest {
            method: "GET".to_string(),
            path: "/tasks".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        assert_eq!(
            authorize_api_request(&request, "private-token", &access)
                .unwrap()
                .status,
            401
        );
        request
            .headers
            .insert("authorization".into(), "Bearer private-token".into());
        assert!(authorize_api_request(&request, "private-token", &access).is_none());
        for method in ["POST", "PATCH", "DELETE", "PUT"] {
            request.method = method.to_string();
            assert_eq!(
                authorize_api_request(&request, "private-token", &access)
                    .unwrap()
                    .status,
                403
            );
        }
        // The public Local API token is deliberately unrelated.
        request.method = "GET".into();
        assert_eq!(
            authorize_api_request(&request, "external-token", &access)
                .unwrap()
                .status,
            401
        );
    }

    #[test]
    fn mcp_shared_operation_revokes_a_write_waiting_for_the_shared_lock() {
        let write_lock = Arc::new(Mutex::new(()));
        let access = LocalApiAccess {
            allow_write: true,
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let guard = lock_recovering(&write_lock);
        let writer_lock = write_lock.clone();
        let writer_access = access.clone();
        let (ready, waiting) = std::sync::mpsc::channel();
        let writer = thread::spawn(move || {
            assert!(writer_access.ensure_write().is_ok());
            ready.send(()).unwrap();
            let result = writer_access.lock_write(&writer_lock).map(|_| ());
            result
        });
        waiting.recv().unwrap();
        access.shutdown.store(true, Ordering::SeqCst);
        drop(guard);
        assert_eq!(
            writer.join().unwrap(),
            Err("Local API server is stopped".into())
        );
        assert_eq!(
            api_error_response(access.ensure_write().unwrap_err()).status,
            403
        );
    }

    /// Every write route serializes on the same `Mutex<()>`, and requests run on their own
    /// threads. One panic in a handler used to poison it for the life of the process: reads
    /// kept working while every POST/PATCH/DELETE answered 500 until restart. A `Mutex<()>`
    /// protects no state a panic could half-mutate, so recover instead of failing.
    #[test]
    fn a_poisoned_write_lock_still_hands_out_a_guard() {
        let write_lock: Arc<Mutex<()>> = Arc::new(Mutex::new(()));
        let poisoner = Arc::clone(&write_lock);
        let panicked = thread::spawn(move || {
            let _guard = poisoner.lock().expect("first lock succeeds");
            panic!("handler panic while holding the write lock");
        })
        .join();
        assert!(panicked.is_err(), "the poisoning thread must have panicked");
        assert!(write_lock.lock().is_err(), "the lock must be poisoned");

        let _guard = lock_recovering(&write_lock);
    }

    fn empty_local_api_data() -> Value {
        json!({
            "tasks": [],
            "projects": [],
            "sections": [],
            "areas": [],
            "people": [],
            "settings": { "deviceId": "device-a" }
        })
    }

    fn project_lifecycle_fixture() -> Value {
        json!({
            "projects": [{"id":"p", "title":"Keep metadata", "status":"active", "rev":7,
                "areaId":"a", "areaTitle":"Area", "updatedAt":"2026-09-01T00:00:00Z"}],
            "sections": [
                {"id":"s", "projectId":"p", "title":"Live", "rev":3},
                {"id":"old", "projectId":"p", "title":"Previously deleted", "rev":4,
                    "deletedAt":"2026-09-01T00:00:00Z"},
                {"id":"purged-section", "projectId":"p", "title":"Purged", "rev":6,
                    "deletedAt":"2026-09-01T00:00:00Z", "purgedAt":"2026-09-01T00:00:00Z"}
            ],
            "tasks": [
                {"id":"direct", "projectId":"p", "status":"next", "rev":2},
                {"id":"indirect", "sectionId":"s", "status":"waiting", "rev":5},
                {"id":"old-section", "sectionId":"old", "status":"someday", "rev":1},
                {"id":"deleted", "projectId":"p", "status":"next", "rev":8,
                    "deletedAt":"2026-09-01T00:00:00Z"},
                {"id":"unrelated", "status":"next", "rev":6},
                {"id":"purged", "projectId":"p", "status":"next", "rev":9,
                    "deletedAt":"2026-09-01T00:00:00Z", "purgedAt":"2026-09-01T00:00:00Z"}
            ],
            "areas":[{"id":"a", "name":"Area"}], "settings":{"deviceId":"local-api-test"}
        })
    }

    #[test]
    fn project_delete_detaches_live_tasks_and_restore_does_not_reattach_them() {
        let mut data = project_lifecycle_fixture();
        let before = data.clone();
        let changed = apply_project_delete_or_restore(&mut data, "p", false).unwrap();
        assert_eq!(changed.projects.len(), 1);
        assert_eq!(changed.sections.len(), 1);
        assert_eq!(changed.tasks.len(), 3);
        assert_eq!(data["projects"][0]["rev"], json!(8));
        assert_eq!(data["projects"][0]["revBy"], json!("local-api-test"));
        assert_eq!(
            data["sections"][0]["deletedAt"],
            data["projects"][0]["deletedAt"]
        );
        assert_eq!(data["sections"][0]["rev"], json!(4));
        for index in 0..3 {
            assert!(data["tasks"][index].get("projectId").is_none());
            assert!(data["tasks"][index].get("sectionId").is_none());
            assert!(data["tasks"][index].get("deletedAt").is_none());
            assert_eq!(
                data["tasks"][index]["status"],
                before["tasks"][index]["status"]
            );
            assert_eq!(
                data["tasks"][index]["rev"].as_i64(),
                before["tasks"][index]["rev"].as_i64().map(|r| r + 1)
            );
        }
        assert_eq!(data["tasks"][3], before["tasks"][3]);
        assert_eq!(data["tasks"][4], before["tasks"][4]);
        assert_eq!(data["tasks"][5], before["tasks"][5]);
        assert_eq!(data["sections"][2], before["sections"][2]);
        let deleted = data.clone();
        assert!(apply_project_delete_or_restore(&mut data, "p", false)
            .unwrap()
            .projects
            .is_empty());
        assert_eq!(data, deleted);
        let restored = apply_project_delete_or_restore(&mut data, "p", true).unwrap();
        assert_eq!(restored.projects.len(), 1);
        assert_eq!(restored.sections.len(), 1);
        assert!(restored.tasks.is_empty());
        assert!(data["projects"][0].get("deletedAt").is_none());
        assert_eq!(data["projects"][0]["rev"], json!(9));
        assert_eq!(data["projects"][0]["areaId"], json!("a"));
        assert!(data["sections"][0].get("deletedAt").is_none());
        assert_eq!(data["sections"][1], before["sections"][1]);
        assert_eq!(data["sections"][2], before["sections"][2]);
        assert_eq!(data["tasks"], deleted["tasks"]);
        let live = data.clone();
        assert!(apply_project_delete_or_restore(&mut data, "p", true)
            .unwrap()
            .projects
            .is_empty());
        assert_eq!(data, live);
    }

    #[test]
    fn project_restore_sanitizes_area_and_restores_only_matching_legacy_cascade() {
        let mut data = project_lifecycle_fixture();
        let deleted_at = "2026-09-02T00:00:00Z";
        data["projects"][0]["deletedAt"] = json!(deleted_at);
        data["areas"][0]["deletedAt"] = json!(deleted_at);
        data["sections"][0]["deletedAt"] = json!(deleted_at);
        data["sections"][2]["deletedAt"] = json!(deleted_at);
        data["tasks"][0]["deletedAt"] = json!(deleted_at);
        data["tasks"][0]["sectionId"] = json!("s");
        data["tasks"][5]["deletedAt"] = json!(deleted_at);
        let before = data.clone();
        let changed = apply_project_delete_or_restore(&mut data, "p", true).unwrap();
        assert_eq!(changed.tasks.len(), 1);
        assert_eq!(changed.sections.len(), 1);
        assert!(data["projects"][0].get("areaId").is_none());
        assert!(data["projects"][0].get("areaTitle").is_none());
        assert!(data["tasks"][0].get("deletedAt").is_none());
        assert_eq!(data["tasks"][0]["sectionId"], json!("s"));
        assert!(has_string_field(&data["tasks"][3], "deletedAt"));
        assert_eq!(data["sections"][1], before["sections"][1]);
        assert_eq!(data["sections"][2], before["sections"][2]);
        assert_eq!(data["tasks"][3], before["tasks"][3]);
        assert_eq!(data["tasks"][5], before["tasks"][5]);
    }

    #[test]
    fn project_lifecycle_missing_and_purged_are_atomic_errors() {
        for restore in [false, true] {
            let mut data = project_lifecycle_fixture();
            let before = data.clone();
            let error = apply_project_delete_or_restore(&mut data, "missing", restore).unwrap_err();
            assert_eq!(api_error_response(error).status, 404);
            assert_eq!(data, before);
            data["projects"][0]["purgedAt"] = json!("2026-09-02T00:00:00Z");
            let before = data.clone();
            let error = apply_project_delete_or_restore(&mut data, "p", restore).unwrap_err();
            assert_eq!(api_error_response(error).status, 409);
            assert_eq!(data, before);
        }
    }

    #[test]
    fn area_patch_is_a_classified_write_operation() {
        let mut request = ApiRequest {
            method: "PATCH".into(),
            path: "/areas/area-1".into(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: br#"{"name":"Work"}"#.to_vec(),
        };
        let operation = operation_from_api_request(&request)
            .unwrap()
            .expect("area patch route");
        assert!(operation.writes());
        assert!(matches!(operation, LocalOperation::PatchArea { id, .. } if id == "area-1"));
        request.method = "GET".into();
        assert!(matches!(operation_from_api_request(&request).unwrap(),
            Some(LocalOperation::GetArea(id)) if id == "area-1"));
        for path in ["/areas", "/v1/areas"] {
            request.path = path.into();
            assert_eq!(
                operation_from_api_request(&request).unwrap(),
                Some(LocalOperation::ListAreas)
            );
        }
        for (method, path) in [
            ("POST", "/areas"),
            ("DELETE", "/areas/area-1"),
            ("PATCH", "/areas"),
            ("PATCH", "/v1/areas/area-1"),
        ] {
            request.method = method.into();
            request.path = path.into();
            assert!(operation_from_api_request(&request).unwrap().is_none());
        }
    }

    fn area_update_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/core/src/__fixtures__/local-api-area-update.json"
        ))
        .unwrap()
    }

    #[test]
    fn area_updates_match_core_golden_cases() {
        let fixture = area_update_fixture();
        for case in fixture["cases"].as_array().unwrap() {
            let mut data = fixture["before"].clone();
            let changed = patch_area_in_data(
                &mut data,
                "area-1",
                case["patch"].as_object().unwrap(),
                fixture["now"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(changed.areas.len(), 1, "{}", case["label"]);
            assert_eq!(
                live_project_area(&data, "area-1").unwrap(),
                &case["expected"]["area"],
                "{}",
                case["label"]
            );
            assert_eq!(
                data["projects"], case["expected"]["projects"],
                "{}",
                case["label"]
            );
            assert_eq!(data["tasks"], fixture["before"]["tasks"]);
            assert_eq!(data["sections"], fixture["before"]["sections"]);
            assert!(changed.tasks.is_empty() && changed.sections.is_empty());
            for area in fixture["before"]["areas"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|area| area["id"] != "area-1")
            {
                assert!(data["areas"].as_array().unwrap().contains(area));
            }
        }
    }

    #[test]
    fn area_name_collisions_match_core_unicode_normalization_without_mutating_rows() {
        let fixture = area_update_fixture();
        for case in fixture["normalizationCases"].as_array().unwrap() {
            let mut data = fixture["before"].clone();
            data["areas"].as_array_mut().unwrap().truncate(2);
            data["areas"][1]["name"] = case["left"].clone();
            let before = data.clone();
            let patch = json!({"name":case["right"],"color":null,"icon":"updated","order":2});
            let result = patch_area_in_data(
                &mut data,
                "area-1",
                patch.as_object().unwrap(),
                fixture["now"].as_str().unwrap(),
            );
            if case["collides"] == true {
                assert_eq!(
                    api_error_response(result.unwrap_err()).status,
                    409,
                    "{case}"
                );
                assert_eq!(data, before, "{case}");
            } else {
                assert!(result.is_ok(), "{case}");
            }
        }
    }

    fn area_http_request(
        port: u16,
        method: &str,
        id: &str,
        body: Value,
        token: &str,
    ) -> (u16, Value) {
        let body = if method == "GET" {
            String::new()
        } else {
            body.to_string()
        };
        // HTTP framing completes the response without waiting for a clean socket EOF.
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let response = client
            .request(
                method.parse().unwrap(),
                format!("http://{LOCAL_API_HOST}:{port}/areas/{id}"),
            )
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .unwrap();
        (response.status().as_u16(), response.json().unwrap())
    }

    #[test]
    fn area_http_request_requires_a_complete_framed_response_without_waiting_for_eof() {
        for content_length in [2, 3] {
            let listener = TcpListener::bind((LOCAL_API_HOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let (finished, completion) = std::sync::mpsc::channel();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                read_request(&mut stream, far_future_deadline())
                    .unwrap()
                    .unwrap();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {content_length}\r\n\r\n{{}}"
                )
                .unwrap();
                if content_length == 2 {
                    completion.recv_timeout(Duration::from_secs(2)).unwrap();
                }
            });
            let result = std::panic::catch_unwind(|| {
                area_http_request(port, "GET", "area-1", Value::Null, "token")
            });
            if content_length == 2 {
                assert_eq!(result.unwrap(), (200, json!({})));
                finished.send(()).unwrap();
            } else {
                assert!(
                    result.is_err(),
                    "a truncated body must fail even if it is valid JSON"
                );
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn area_http_updates_are_durable_and_fail_atomically() {
        use crate::storage::{
            local_area_operation_test_commit, local_operation_test_seed, read_sqlite_data,
        };
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("areas.sqlite");
        let fixture = area_update_fixture();
        let mut conn = rusqlite::Connection::open(&database).unwrap();
        local_operation_test_seed(&mut conn, &fixture["before"]).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let before = read_sqlite_data(&conn).unwrap();
        let handler_database = database.clone();
        let write_lock = Arc::new(Mutex::new(()));
        let listener = start_http_listener(0, true, move |access, _, request| {
            handle_api_operation("area-http-token", access, request, |operation| {
                let _guard = if operation.writes() {
                    Some(access.lock_write(&write_lock)?)
                } else {
                    None
                };
                let conn = rusqlite::Connection::open(&handler_database)
                    .map_err(|error| error.to_string())?;
                conn.execute_batch("PRAGMA foreign_keys=ON;")
                    .map_err(|error| error.to_string())?;
                let (id, data) = match operation {
                    LocalOperation::PatchArea { id, body } => {
                        let data = local_area_operation_test_commit(&conn, &id, |data| {
                            Ok((
                                (),
                                patch_area_in_data(data, &id, &body, "2026-10-11T12:00:00.000Z")?,
                            ))
                        })?;
                        (id, data)
                    }
                    LocalOperation::GetArea(id) => (id, read_sqlite_data(&conn)?),
                    _ => return Err("Unsupported test operation".into()),
                };
                Ok(json!({"area": live_project_area(&data, &id).ok_or("Area not found")?}))
            })
        })
        .unwrap();
        let port = listener.port;
        let token = "area-http-token";
        assert_eq!(
            area_http_request(port, "GET", "missing", Value::Null, token).0,
            404
        );
        assert_eq!(
            area_http_request(port, "GET", "deleted-area", Value::Null, token).0,
            404
        );
        assert_eq!(
            area_http_request(
                port,
                "PATCH",
                "area-1",
                json!({"name":"Unauthorized"}),
                "wrong"
            )
            .0,
            401
        );
        for (id, patch, status) in [
            ("missing", json!({"name":"Office"}), 404),
            ("deleted-area", json!({"name":"Office"}), 404),
            ("area-1", json!({}), 400),
            ("area-1", json!({"name":"\u{feff} \t"}), 400),
            ("area-1", json!({"name":null}), 400),
            ("area-1", json!({"name":1}), 400),
            ("area-1", json!({"order":null}), 400),
            ("area-1", json!({"order":"1"}), 400),
            ("area-1", json!({"color":false}), 400),
            ("area-1", json!({"icon":1}), 400),
            ("area-1", json!({"rev":20}), 400),
            (
                "area-1",
                json!({"name":"\u{feff}hOmE\u{feff}","color":"#10b981","icon":null,"order":1.5}),
                409,
            ),
        ] {
            assert_eq!(
                area_http_request(port, "PATCH", id, patch.clone(), token).0,
                status,
                "{id} {patch}"
            );
            assert_eq!(
                read_sqlite_data(&conn).unwrap(),
                before,
                "rejected request must not change rows"
            );
        }
        conn.execute_batch(
            "CREATE TRIGGER reject_area_project BEFORE UPDATE ON projects WHEN NEW.id = 'archived'
            BEGIN SELECT RAISE(ABORT, 'injected area project failure'); END;",
        )
        .unwrap();
        assert_eq!(
            area_http_request(
                port,
                "PATCH",
                "area-1",
                json!({"name":"Office","color":"#10b981"}),
                token
            )
            .0,
            500
        );
        assert_eq!(
            read_sqlite_data(&conn).unwrap(),
            before,
            "failure rolls back area and earlier project writes"
        );
        conn.execute_batch("DROP TRIGGER reject_area_project;")
            .unwrap();
        let (status, response) = area_http_request(
            port,
            "PATCH",
            "area-1",
            fixture["cases"][0]["patch"].clone(),
            token,
        );
        assert_eq!(status, 200);
        assert_eq!(
            response,
            json!({"area": fixture["cases"][0]["expected"]["area"]})
        );
        let after = read_sqlite_data(&conn).unwrap();
        for expected in fixture["cases"][0]["expected"]["projects"]
            .as_array()
            .unwrap()
        {
            let actual = find_project(&after, expected["id"].as_str().unwrap()).unwrap();
            for (field, value) in expected.as_object().unwrap() {
                assert_eq!(&actual[field], value, "{} {field}", expected["id"]);
            }
        }
        assert_eq!(
            after["tasks"], before["tasks"],
            "child foreign keys and content survive"
        );
        assert_eq!(after["sections"], before["sections"]);
        assert_eq!(
            area_http_request(port, "GET", "area-1", Value::Null, token),
            (200, response)
        );
        drop(conn);
        let reopened = rusqlite::Connection::open(&database).unwrap();
        assert_eq!(
            read_sqlite_data(&reopened).unwrap(),
            after,
            "HTTP success survives database reopen"
        );
        drop(listener);
    }

    #[test]
    fn area_http_read_only_denies_patch_before_execution() {
        let listener = start_http_listener(0, false, |access, _, request| {
            handle_api_operation("area-http-token", access, request, |_| {
                panic!("read-only area patch must not reach storage")
            })
        })
        .unwrap();
        assert_eq!(
            area_http_request(
                listener.port,
                "PATCH",
                "area-1",
                json!({"name":"Office"}),
                "area-http-token"
            )
            .0,
            403
        );
        drop(listener);
    }

    #[test]
    fn normalizes_default_local_api_port() {
        assert_eq!(
            normalize_local_api_port(None).unwrap(),
            DEFAULT_LOCAL_API_PORT
        );
        assert!(normalize_local_api_port(Some(80)).is_err());
    }

    #[test]
    fn parses_request_target_query_values() {
        let (path, query) = parse_request_target("/tasks?query=call+mom&status=next");
        assert_eq!(path, "/tasks");
        assert_eq!(query.get("query").map(String::as_str), Some("call mom"));
        assert_eq!(query.get("status").map(String::as_str), Some("next"));
    }

    // R-04: without the deadline check, a client that sends a partial
    // request and then goes silent would block read_request on read()
    // forever (nothing here ever closes the socket or sends more data). An
    // already-expired deadline must be caught at the top of the loop before
    // that blocking read is attempted at all.
    #[test]
    fn read_request_aborts_a_slow_drip_connection_once_the_deadline_passes() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(addr).unwrap();
        client.write_all(b"GET / HTTP/1.1\r\n").unwrap();

        let (mut stream, _) = listener.accept().unwrap();
        let deadline = Instant::now() - Duration::from_millis(1);
        let started = Instant::now();
        let result = read_request(&mut stream, deadline);
        assert_eq!(result.unwrap_err(), "Request timed out");
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "the deadline check must short-circuit before blocking on read(), took {:?}",
            started.elapsed()
        );
    }

    // I3: without a write timeout, write_all against a peer that never drains
    // its socket buffer blocks forever - and since accept_or_reject's 503
    // rejection runs synchronously on the accept loop's own thread, that
    // would stop the server from accepting any connection at all, not just
    // pin one of the capped slots. TcpStream::write_timeout() reads back
    // what's actually configured on the socket, so this checks the real
    // write_response wiring directly and fast, instead of filling a send
    // buffer with a non-reading peer to force an actual multi-second block.
    #[test]
    fn write_response_sets_a_write_timeout_so_a_non_reading_peer_cannot_block_it_forever() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let _client = TcpStream::connect(addr).unwrap();
        let (mut stream, _) = listener.accept().unwrap();

        write_response(&mut stream, ApiResponse::ok(json!({}))).unwrap();

        assert_eq!(
            stream.write_timeout().unwrap(),
            Some(Duration::from_secs(5))
        );
    }

    // Feeds fixed byte chunks to read_request one read() call at a time, so
    // a test can force "split across multiple reads" deterministically and
    // instantly - no real sockets or sleeps needed (R-05).
    struct ChunkedReader {
        chunks: std::collections::VecDeque<Vec<u8>>,
    }

    impl ChunkedReader {
        fn new(chunks: Vec<&[u8]>) -> Self {
            Self {
                chunks: chunks.into_iter().map(|chunk| chunk.to_vec()).collect(),
            }
        }
    }

    impl Read for ChunkedReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let Some(mut chunk) = self.chunks.pop_front() else {
                return Ok(0);
            };
            let len = chunk.len().min(buf.len());
            buf[..len].copy_from_slice(&chunk[..len]);
            if len < chunk.len() {
                chunk.drain(..len);
                self.chunks.push_front(chunk);
            }
            Ok(len)
        }
    }

    fn far_future_deadline() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }

    #[test]
    fn read_request_rejects_oversized_headers() {
        let garbage = vec![b'x'; REQUEST_HEADER_LIMIT_BYTES + 1];
        let mut reader = ChunkedReader::new(vec![&garbage]);
        assert_eq!(
            read_request(&mut reader, far_future_deadline()).unwrap_err(),
            "Request headers too large"
        );
    }

    #[test]
    fn read_request_rejects_oversized_declared_content_length() {
        let request = format!(
            "POST /tasks HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            REQUEST_BODY_LIMIT_BYTES + 1
        );
        let mut reader = ChunkedReader::new(vec![request.as_bytes()]);
        assert_eq!(
            read_request(&mut reader, far_future_deadline()).unwrap_err(),
            "Request body too large"
        );
    }

    #[test]
    fn read_request_reassembles_a_body_split_across_reads() {
        let body = b"{\"a\":1}";
        let header = format!(
            "POST /tasks HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        let (body_first, body_second) = body.split_at(3);
        let mut reader = ChunkedReader::new(vec![header.as_bytes(), body_first, body_second]);
        let request = read_request(&mut reader, far_future_deadline())
            .unwrap()
            .unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/tasks");
        assert_eq!(request.body, body);
    }

    #[test]
    fn read_request_rejects_a_missing_request_line() {
        let mut reader = ChunkedReader::new(vec![b"\r\n\r\n"]);
        assert_eq!(
            read_request(&mut reader, far_future_deadline()).unwrap_err(),
            "Missing HTTP method"
        );
    }

    #[test]
    fn read_request_rejects_non_utf8_header_bytes() {
        let invalid = b"GET / HTTP/1.1\r\nX-Bad: \xff\xfe\r\n\r\n";
        let mut reader = ChunkedReader::new(vec![invalid]);
        assert_eq!(
            read_request(&mut reader, far_future_deadline()).unwrap_err(),
            "Invalid HTTP header encoding"
        );
    }

    #[test]
    fn accept_or_reject_allows_connections_under_the_cap() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let _client = TcpStream::connect(addr).unwrap();
        let (stream, _) = listener.accept().unwrap();

        let active_connections = Arc::new(AtomicUsize::new(MAX_LOCAL_API_CONNECTIONS - 1));
        assert!(accept_or_reject(stream, &active_connections).is_some());
        assert_eq!(
            active_connections.load(Ordering::SeqCst),
            MAX_LOCAL_API_CONNECTIONS
        );
    }

    // R-04: the 33rd concurrent connection (cap already at 32) gets a 503
    // instead of a thread.
    #[test]
    fn accept_or_reject_serves_503_once_the_connection_cap_is_reached() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(addr).unwrap();
        let (stream, _) = listener.accept().unwrap();

        let active_connections = Arc::new(AtomicUsize::new(MAX_LOCAL_API_CONNECTIONS));
        assert!(accept_or_reject(stream, &active_connections).is_none());
        assert_eq!(
            active_connections.load(Ordering::SeqCst),
            MAX_LOCAL_API_CONNECTIONS,
            "a rejected connection must not consume a slot"
        );

        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 503"), "got: {response}");
        assert!(response.contains("Local API server is busy"));
    }

    #[test]
    fn filters_active_tasks_by_default() {
        let tasks = vec![
            json!({ "id": "1", "title": "A", "status": "next" }),
            json!({ "id": "2", "title": "B", "status": "done" }),
            json!({ "id": "3", "title": "C", "status": "next", "deletedAt": "now" }),
        ];
        let filtered = filter_tasks(tasks, &HashMap::new()).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(
            filtered[0].get("id").and_then(|value| value.as_str()),
            Some("1")
        );
    }

    #[test]
    fn filters_tasks_by_focused_today_boolean_query() {
        let tasks = vec![
            json!({ "id": "focused-bool", "status": "next", "isFocusedToday": true }),
            json!({ "id": "focused-number", "status": "next", "isFocusedToday": 1 }),
            json!({ "id": "not-focused-bool", "status": "next", "isFocusedToday": false }),
            json!({ "id": "not-focused-number", "status": "next", "isFocusedToday": 0 }),
            json!({ "id": "not-focused-missing", "status": "next" }),
        ];

        for raw in ["true", "1", " TRUE "] {
            let query = HashMap::from([("isFocusedToday".to_string(), raw.to_string())]);
            let filtered = filter_tasks(tasks.clone(), &query).unwrap();
            let ids = filtered
                .iter()
                .filter_map(|task| task.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>();
            assert_eq!(ids, vec!["focused-bool", "focused-number"], "{raw}");
        }

        for raw in ["false", "0", " FALSE "] {
            let query = HashMap::from([("isFocusedToday".to_string(), raw.to_string())]);
            let filtered = filter_tasks(tasks.clone(), &query).unwrap();
            let ids = filtered
                .iter()
                .filter_map(|task| task.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>();
            assert_eq!(
                ids,
                vec![
                    "not-focused-bool",
                    "not-focused-number",
                    "not-focused-missing"
                ],
                "{raw}"
            );
        }
    }

    #[test]
    fn rejects_invalid_focused_today_query_as_bad_request() {
        for raw in ["", "yes", "2"] {
            let query = HashMap::from([("isFocusedToday".to_string(), raw.to_string())]);
            let error = filter_tasks(Vec::new(), &query).unwrap_err();
            assert_eq!(error, "Invalid isFocusedToday");
            assert_eq!(api_error_response(error).status, 400, "{raw}");
        }
    }

    /// Mirrors `packages/core/src/task-query.test.ts` against the SAME
    /// (tasks, query) -> expected ids fixture table. `filter_tasks`'s query
    /// param shape can't express every case the JS/SQL sides cover
    /// (`excludeStatuses` lists, `projectId`, or "hide archived but keep
    /// done" independently of `done`) - those cases carry `rustQuery: null`
    /// and are skipped here; the TS test is the one asserting the full
    /// fixture-name roster hasn't shrunk.
    #[test]
    fn local_api_filter_tasks_matches_task_query_fixture() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/task-query.fixtures.json"
        ))
        .expect("valid task query fixture");
        let cases = cases.as_array().expect("fixture array");
        let mut ran = 0;

        for test_case in cases {
            let name = test_case
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unnamed task query case");
            let Some(rust_query) = test_case.get("rustQuery").and_then(Value::as_object) else {
                continue;
            };
            let tasks = test_case
                .get("tasks")
                .and_then(Value::as_array)
                .unwrap_or_else(|| panic!("missing tasks array for {name}"))
                .clone();
            let expected_ids: Vec<String> = test_case
                .get("expectedIds")
                .and_then(Value::as_array)
                .unwrap_or_else(|| panic!("missing expectedIds for {name}"))
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect();
            let query: HashMap<String, String> = rust_query
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|v| (key.clone(), v.to_string())))
                .collect();

            let filtered = filter_tasks(tasks, &query)
                .unwrap_or_else(|error| panic!("filter_tasks failed for {name}: {error}"));
            let mut ids: Vec<String> = filtered
                .iter()
                .filter_map(|task| task.get("id").and_then(Value::as_str).map(str::to_string))
                .collect();
            ids.sort();
            let mut expected_ids = expected_ids;
            expected_ids.sort();
            assert_eq!(ids, expected_ids, "{name}");
            ran += 1;
        }

        // Sanity check on the check itself: if every case ever became
        // `rustQuery: null`, the loop above would pass vacuously.
        assert!(
            ran > 0,
            "expected at least one Rust-expressible fixture case"
        );
    }

    #[test]
    fn local_api_requires_bearer_token() {
        let mut headers = HashMap::new();
        headers.insert("authorization".to_string(), "Bearer secret".to_string());
        let authorized = ApiRequest {
            method: "GET".to_string(),
            path: "/tasks".to_string(),
            query: HashMap::new(),
            headers,
            body: Vec::new(),
        };
        let unauthorized = ApiRequest {
            method: "GET".to_string(),
            path: "/tasks".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: Vec::new(),
        };

        assert!(is_request_authorized(&authorized, "secret"));
        assert!(!is_request_authorized(&unauthorized, "secret"));
    }

    #[test]
    fn local_api_response_does_not_enable_wildcard_cors() {
        let response = ApiResponse::ok(json!({ "ok": true }));
        let raw = http_response(&response);

        assert!(!raw.contains("Access-Control-Allow-Origin"));
        assert!(!raw.contains("Access-Control-Allow-Methods"));
    }

    #[test]
    fn local_api_tasks_include_revision_metadata() {
        let mut body = Map::new();
        body.insert("input".to_string(), Value::String("Call Alice".to_string()));

        let task = create_task_from_body(&body, "device-a", &empty_local_api_data()).expect("task");

        assert_eq!(task.get("rev").and_then(|value| value.as_i64()), Some(1));
        assert_eq!(
            task.get("revBy").and_then(|value| value.as_str()),
            Some("device-a")
        );
    }

    #[test]
    fn local_api_patch_preserves_recurrence_series_identity() {
        let mut task = json!({
            "id": "weekly-occurrence",
            "title": "Timeblock",
            "status": "next",
            "recurrence": {
                "rule": "weekly",
                "strategy": "strict",
                "seriesId": "weekly-series"
            },
            "createdAt": "2026-06-01T00:00:00Z",
            "updatedAt": "2026-06-01T00:00:00Z",
            "rev": 1
        })
        .as_object()
        .expect("task object")
        .clone();
        let patch = json!({
            "recurrence": {
                "rule": "weekly",
                "strategy": "fluid"
            }
        });

        apply_task_patch(
            &mut task,
            patch.as_object().expect("patch object"),
            "device-a",
        )
        .expect("patch");

        assert_eq!(
            task.get("recurrence")
                .and_then(|value| value.get("seriesId"))
                .and_then(Value::as_str),
            Some("weekly-series")
        );

        let legacy_patch = json!({ "recurrence": "daily" });
        apply_task_patch(
            &mut task,
            legacy_patch.as_object().expect("patch object"),
            "device-a",
        )
        .expect("legacy patch");

        assert_eq!(
            task.get("recurrence"),
            Some(&json!({ "rule": "daily", "seriesId": "weekly-series" }))
        );
    }

    #[test]
    fn local_api_patch_route_rejects_a_section_from_another_project() {
        let mut data = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "Organized", "status": "next",
                "projectId": "project-a", "sectionId": "section-a",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
            }],
            "projects": [
                { "id": "project-a", "title": "A", "status": "active" },
                { "id": "project-b", "title": "B", "status": "active" }
            ],
            "sections": [
                { "id": "section-a", "projectId": "project-a", "title": "A section" },
                { "id": "section-b", "projectId": "project-b", "title": "B section" }
            ],
            "areas": [{ "id": "area-a", "name": "Area" }],
            "settings": { "deviceId": "desktop-local-api" }
        });

        let error = patch_task_in_data(
            &mut data,
            "task-1",
            json!({ "projectId": "project-b", "sectionId": "section-a" })
                .as_object()
                .expect("patch object"),
        )
        .expect_err("a section cannot be persisted under another project");

        assert_eq!(
            error,
            "Invalid task sectionId: Section does not belong to project"
        );
        assert_eq!(data["tasks"][0]["projectId"], "project-a");
        assert_eq!(data["tasks"][0]["sectionId"], "section-a");
        assert_eq!(data["tasks"][0]["rev"], 1);
    }

    #[test]
    fn local_api_patch_route_normalizes_partial_container_moves() {
        let mut data = serde_json::json!({
            "tasks": [
                {
                    "id": "organized", "title": "Organized", "status": "next",
                    "projectId": "project-a", "sectionId": "section-a", "areaId": "area-a",
                    "order": 7, "orderNum": 7,
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                },
                {
                    "id": "uncontained", "title": "Uncontained", "status": "next",
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                }
            ],
            "projects": [
                { "id": "project-a", "title": "A", "status": "active" },
                { "id": "project-b", "title": "B", "status": "active" }
            ],
            "sections": [
                { "id": "section-a", "projectId": "project-a", "title": "A section" },
                { "id": "section-b", "projectId": "project-b", "title": "B section" }
            ],
            "areas": [{ "id": "area-a", "name": "Area" }],
            "settings": { "deviceId": "desktop-local-api" }
        });

        let moved = patch_task_in_data(
            &mut data,
            "organized",
            json!({ "projectId": "project-b" })
                .as_object()
                .expect("project patch"),
        )
        .expect("project move");
        assert_eq!(moved["projectId"], "project-b");
        assert!(moved.get("sectionId").is_none());
        assert!(moved.get("areaId").is_none());

        let sectioned = patch_task_in_data(
            &mut data,
            "uncontained",
            json!({ "sectionId": "section-b", "areaId": "area-a" })
                .as_object()
                .expect("section patch"),
        )
        .expect("section infers its owning project");
        assert_eq!(sectioned["projectId"], "project-b");
        assert_eq!(sectioned["sectionId"], "section-b");
        assert!(sectioned.get("areaId").is_none());

        let area_task = patch_task_in_data(
            &mut data,
            "organized",
            json!({ "projectId": null, "areaId": "area-a" })
                .as_object()
                .expect("area patch"),
        )
        .expect("area move");
        assert!(area_task.get("projectId").is_none());
        assert!(area_task.get("sectionId").is_none());
        assert_eq!(area_task["areaId"], "area-a");
        assert!(area_task.get("order").is_none());
        assert!(area_task.get("orderNum").is_none());
    }

    #[test]
    fn local_api_patch_route_preserves_implicit_archived_section_references() {
        let archived_at = "2026-09-01T00:00:00Z";
        let base = serde_json::json!({
            "tasks": [{
                "id": "task-1", "title": "Finished", "status": "done",
                "projectId": "project-1", "sectionId": "section-1",
                "completedAt": archived_at,
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": archived_at, "updatedAt": archived_at
            }],
            "projects": [{
                "id": "project-1", "title": "Archived", "status": "archived"
            }],
            "sections": [{
                "id": "section-1", "projectId": "project-1", "title": "Archived section",
                "deletedAt": archived_at, "projectArchivedAt": archived_at
            }],
            "areas": [{ "id": "area-1", "name": "Area" }],
            "settings": { "deviceId": "desktop-local-api" }
        });

        let mut implicit = base.clone();
        let patched = patch_task_in_data(
            &mut implicit,
            "task-1",
            json!({ "areaId": "area-1" })
                .as_object()
                .expect("area patch"),
        )
        .expect("implicit archived section reference remains valid");
        assert_eq!(patched["projectId"], "project-1");
        assert_eq!(patched["sectionId"], "section-1");
        assert!(patched.get("areaId").is_none());

        let mut explicit = base;
        let original = explicit.clone();
        let error = patch_task_in_data(
            &mut explicit,
            "task-1",
            json!({ "sectionId": "section-1" })
                .as_object()
                .expect("section patch"),
        )
        .expect_err("deleted sections cannot be explicitly assigned");
        assert_eq!(error, "Invalid task sectionId: Section not found");
        assert_eq!(explicit, original, "rejection must be atomic");
    }

    #[test]
    fn local_api_patch_route_appends_project_moves_and_honors_explicit_order_aliases() {
        let mut data = serde_json::json!({
            "tasks": [
                {
                    "id": "implicit", "title": "Implicit", "status": "next",
                    "projectId": "project-a", "order": 7, "orderNum": 7,
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                },
                {
                    "id": "explicit-order", "title": "Explicit order", "status": "next",
                    "projectId": "project-a", "order": 8, "orderNum": 8,
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                },
                {
                    "id": "explicit-order-num", "title": "Explicit orderNum", "status": "next",
                    "projectId": "project-a", "order": 9, "orderNum": 9,
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                },
                {
                    "id": "destination-high", "title": "Destination", "status": "next",
                    "projectId": "project-b", "sectionId": "section-b",
                    "order": 5, "orderNum": 5,
                    "tags": [], "contexts": [], "rev": 1,
                    "createdAt": "2026-08-01T10:00:00Z", "updatedAt": "2026-08-01T10:00:00Z"
                }
            ],
            "projects": [
                { "id": "project-a", "title": "A", "status": "active" },
                { "id": "project-b", "title": "B", "status": "active" }
            ],
            "sections": [
                { "id": "section-b", "projectId": "project-b", "title": "B section" }
            ],
            "areas": [],
            "settings": { "deviceId": "desktop-local-api" }
        });

        let implicit = patch_task_in_data(
            &mut data,
            "implicit",
            json!({ "projectId": "project-b" })
                .as_object()
                .expect("implicit project patch"),
        )
        .expect("implicit project move");
        assert_eq!(implicit["order"], 6);
        assert_eq!(implicit["orderNum"], 6);

        let explicit_order = patch_task_in_data(
            &mut data,
            "explicit-order",
            json!({ "projectId": "project-b", "order": 3 })
                .as_object()
                .expect("explicit order patch"),
        )
        .expect("explicit order move");
        assert_eq!(explicit_order["order"], 3);
        assert_eq!(explicit_order["orderNum"], 3);

        let explicit_order_num = patch_task_in_data(
            &mut data,
            "explicit-order-num",
            json!({ "projectId": "project-b", "orderNum": 4 })
                .as_object()
                .expect("explicit orderNum patch"),
        )
        .expect("explicit orderNum move");
        assert_eq!(explicit_order_num["order"], 4);
        assert_eq!(explicit_order_num["orderNum"], 4);
    }

    #[test]
    fn local_api_due_date_patch_recomputes_relative_start() {
        let mut task = json!({
            "id": "task-1", "title": "Scheduled", "status": "next",
            "tags": [], "contexts": [], "rev": 1,
            "dueDate": "2026-08-10", "startTime": "2026-08-08",
            "relativeStartOffset": { "amount": -2, "unit": "day" },
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T10:00:00Z"
        })
        .as_object()
        .expect("task object")
        .clone();

        apply_task_patch(
            &mut task,
            json!({ "dueDate": "2026-08-20" })
                .as_object()
                .expect("patch object"),
            "device-a",
        )
        .expect("due date patch");

        assert_eq!(task["startTime"], "2026-08-18");
        assert_eq!(
            task["relativeStartOffset"],
            json!({ "amount": -2, "unit": "day" })
        );
    }

    #[test]
    fn local_api_manual_start_clears_relative_offset() {
        let mut task = json!({
            "id": "task-1", "title": "Scheduled", "status": "next",
            "tags": [], "contexts": [], "rev": 1,
            "dueDate": "2026-08-20", "startTime": "2026-08-18",
            "relativeStartOffset": { "amount": -2, "unit": "day" },
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T10:00:00Z"
        })
        .as_object()
        .expect("task object")
        .clone();

        apply_task_patch(
            &mut task,
            json!({ "startTime": "2026-08-19" })
                .as_object()
                .expect("patch object"),
            "device-a",
        )
        .expect("manual start patch");

        assert_eq!(task["startTime"], "2026-08-19");
        assert!(!task.contains_key("relativeStartOffset"));

        apply_task_patch(
            &mut task,
            json!({ "relativeStartOffset": { "amount": -1, "unit": "hour" } })
                .as_object()
                .expect("patch object"),
            "device-a",
        )
        .expect("incompatible offset is cleared");
        assert!(!task.contains_key("relativeStartOffset"));
        assert_eq!(task["startTime"], "2026-08-19");
    }

    #[test]
    fn local_api_patch_rejects_unknown_and_managed_fields() {
        for patch in [
            json!({ "surprise": true }),
            json!({ "id": "replacement-id" }),
            json!({ "rev": 99 }),
        ] {
            let mut patch = patch.as_object().expect("patch object").clone();
            assert!(sanitize_task_patch_map(&mut patch).is_err());
        }
    }

    #[test]
    fn local_api_patch_rejects_null_or_invalid_required_fields() {
        for patch in [
            json!({ "title": null }),
            json!({ "title": "" }),
            json!({ "title": "x".repeat(MAX_TASK_TITLE_LENGTH + 1) }),
            json!({ "status": null }),
            json!({ "status": 1 }),
            json!({ "tags": null }),
            json!({ "tags": ["#valid", 2] }),
            json!({ "tags": ["   "] }),
            json!({ "tags": ["x".repeat(MAX_TASK_TOKEN_LENGTH + 1)] }),
            json!({ "contexts": "@home" }),
            json!({ "contexts": ["\t"] }),
            json!({ "isFocusedToday": null }),
            json!({ "showFutureRecurrence": null }),
            json!({ "suppressMindwtrReminders": null }),
        ] {
            let mut patch = patch.as_object().expect("patch object").clone();
            assert!(sanitize_task_patch_map(&mut patch).is_err(), "{patch:?}");
        }
    }

    #[test]
    fn local_api_patch_validates_optional_field_types() {
        for patch in [
            json!({ "isFocusedToday": "yes" }),
            json!({ "timeSpentMinutes": 1.5 }),
            json!({ "order": "first" }),
            json!({ "order": 2.5 }),
            json!({ "orderNum": -1.5 }),
            json!({ "boardOrder": 0.25 }),
            json!({ "focusOrder": 3.75 }),
            json!({ "checklist": {} }),
            json!({ "attachments": "file" }),
            json!({ "relativeStartOffset": [] }),
            json!({ "recurrence": [] }),
            json!({ "timeEstimate": "45min" }),
            json!({ "timeEstimate": "custom:" }),
            json!({ "timeEstimate": "custom:0" }),
            json!({ "timeEstimate": "custom:-1" }),
            json!({ "timeEstimate": "custom:NaN" }),
            json!({ "timeEstimate": "custom:inf" }),
            json!({ "checklist": [{ "title": "Missing id", "isCompleted": false }] }),
            json!({ "attachments": [{ "id": "attachment-1", "kind": "file" }] }),
            json!({ "recurrence": { "rule": "daily", "strategy": 1 } }),
        ] {
            let mut patch = patch.as_object().expect("patch object").clone();
            assert!(sanitize_task_patch_map(&mut patch).is_err(), "{patch:?}");
        }

        let mut valid = json!({
            "title": "Validated",
            "status": "next",
            "tags": [" #home ", "x".repeat(MAX_TASK_TOKEN_LENGTH)],
            "contexts": [" @desk "],
            "isFocusedToday": true,
            "timeSpentMinutes": 10,
            "order": 2.0,
            "orderNum": -1,
            "boardOrder": 0,
            "focusOrder": 3,
            "checklist": [{ "id": "item-1", "title": "Item" }],
            "attachments": [],
            "relativeStartOffset": { "amount": -1, "unit": "day" },
            "recurrence": { "rule": "daily" },
            "timeEstimate": "custom:42.5",
            "description": null
        })
        .as_object()
        .expect("patch object")
        .clone();
        sanitize_task_patch_map(&mut valid).expect("valid patch");
        assert_eq!(valid["tags"][0], "#home");
        assert_eq!(valid["contexts"][0], "@desk");
        assert_eq!(valid["checklist"][0]["isCompleted"], false);

        for estimate in ["5min", "4hr+", "custom:1", "custom:15"] {
            assert!(valid_time_estimate(&Value::String(estimate.to_string())));
        }
    }

    #[test]
    fn local_api_valid_attachments_accepts_content_identity_fields() {
        // #370b74f09 added contentRev/contentMtimeMs/contentSize; a GET-edit-PUT
        // round trip of a task with a synced file attachment must not be rejected.
        let round_trip = json!([{
            "id": "attachment-1",
            "kind": "file",
            "title": "Report",
            "uri": "file:///report.pdf",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "cloudKey": "attachments/report.pdf",
            "fileHash": "hash",
            "localStatus": "available",
            "size": 4096,
            "contentRev": 3,
            "contentMtimeMs": 1750000000000_u64,
            "contentSize": 4096,
            "pendingContentUpload": true,
            "staleContentHash": "b".repeat(64),
        }]);
        assert!(valid_attachments(&round_trip));
        for (field, bad_value) in [
            ("pendingContentUpload", json!("yes")),
            ("staleContentHash", json!(7)),
        ] {
            let mut attachment = round_trip[0].clone();
            attachment[field] = bad_value.clone();
            assert!(
                !valid_attachments(&json!([attachment])),
                "{field} should reject {bad_value:?}"
            );
        }

        for field in ["contentRev", "contentMtimeMs", "contentSize"] {
            for bad_value in [json!("not-a-number"), json!(null), json!(-1)] {
                let mut attachment = json!({
                    "id": "attachment-1",
                    "kind": "file",
                    "title": "Report",
                    "uri": "file:///report.pdf",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z",
                });
                attachment[field] = bad_value.clone();
                let patch = json!([attachment]);
                assert!(
                    !valid_attachments(&patch),
                    "{field} should reject {bad_value:?}"
                );
            }
        }
    }

    #[test]
    fn local_api_valid_attachments_enforces_cloud_key_shape() {
        // SEC-08: the local HTTP API is a second write path into the same attachments, so a
        // cloudKey it accepts must be one the sync merge would accept too
        // (ATTACHMENT_CLOUD_KEY_PATTERN in packages/core/src/sync-normalization.ts).
        let with_cloud_key = |cloud_key: &str| {
            json!([{
                "id": "attachment-1",
                "kind": "file",
                "title": "Report",
                "uri": "file:///report.pdf",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "cloudKey": cloud_key,
            }])
        };

        for accepted in [
            "attachments/att-1.txt",
            "attachments/att-1",
            "attachments/a1.tar.gz",
            "cloudkit:ABC123",
        ] {
            assert!(
                valid_attachments(&with_cloud_key(accepted)),
                "{accepted} should be accepted"
            );
        }

        for rejected in [
            "../secret",
            "attachments/../../secret",
            "/etc/passwd",
            "attachments/secret\0.txt",
            "attachments/",
            "attachments/.hidden",
            "attachments/a/b.txt",
            "",
            "https://example.com/x",
        ] {
            assert!(
                !valid_attachments(&with_cloud_key(rejected)),
                "{rejected:?} should be rejected"
            );
        }
    }

    #[test]
    fn local_api_duplicate_attachment_resets_content_identity_fields() {
        // Mirrors core's duplicateProjectAttachmentCopy semantics: a duplicated
        // attachment must not share cloudKey/fileHash/content-identity with the
        // original, or two records point at one cloud blob.
        let original = json!([{
            "id": "attachment-1",
            "kind": "file",
            "title": "Report",
            "uri": "file:///report.pdf",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "cloudKey": "attachments/report.pdf",
            "fileHash": "hash",
            "localStatus": "available",
            "contentRev": 3,
            "contentMtimeMs": 1750000000000_u64,
            "contentSize": 4096,
            "pendingContentUpload": true,
            "staleContentHash": "b".repeat(64),
        }]);
        let duplicated = duplicate_attachment_value(Some(&original), "2026-01-02T00:00:00.000Z")
            .expect("duplicated attachments");
        let copy = duplicated[0].as_object().expect("attachment object");
        assert_eq!(copy.get("uri"), Some(&json!("file:///report.pdf")));
        assert!(!copy.contains_key("cloudKey"));
        assert!(!copy.contains_key("fileHash"));
        assert!(!copy.contains_key("localStatus"));
        assert!(!copy.contains_key("contentRev"));
        assert!(!copy.contains_key("contentMtimeMs"));
        assert!(!copy.contains_key("contentSize"));
        assert!(!copy.contains_key("pendingContentUpload"));
        assert!(!copy.contains_key("staleContentHash"));
    }

    #[test]
    fn local_api_patch_rejects_terminal_status_targets() {
        let mut task = json!({
            "id": "task-1", "title": "Lifecycle", "status": "next",
            "tags": [], "contexts": [], "rev": 1,
            "createdAt": "2026-07-31T10:00:00Z", "updatedAt": "2026-07-31T10:00:00Z"
        })
        .as_object()
        .expect("task object")
        .clone();
        let original = task.clone();

        let error = apply_task_patch(
            &mut task,
            json!({ "status": "done" })
                .as_object()
                .expect("patch object"),
            "device-a",
        )
        .expect_err("terminal status changes require lifecycle actions");

        assert!(error.contains("/complete or /archive"));
        assert_eq!(task, original);
        assert_eq!(api_error_response(error).status, 400);
    }

    #[test]
    fn local_api_patch_validates_canonical_task_dates() {
        for patch in [
            json!({ "startTime": "2026-02-30" }),
            json!({ "dueDate": "2026-01-01T25:00:00Z" }),
            json!({ "reviewAt": "2026-01-01T12:00:00" }),
            json!({ "reviewAt": "tomorrow" }),
        ] {
            let mut patch = patch.as_object().expect("patch object").clone();
            assert!(sanitize_task_patch_map(&mut patch).is_err(), "{patch:?}");
        }

        let mut valid = json!({
            "startTime": "2024-02-29",
            "dueDate": "2026-01-01T12:34:56.123+02:30",
            "reviewAt": null
        })
        .as_object()
        .expect("patch object")
        .clone();
        sanitize_task_patch_map(&mut valid).expect("canonical dates");
    }

    #[test]
    fn local_api_patch_rejects_invalid_recurrence_until_and_rrule() {
        for recurrence in [
            json!({ "rule": "daily", "until": "2026-02-30" }),
            json!({ "rule": "daily", "until": "eventually" }),
            json!({ "rule": "daily", "rrule": "anything" }),
            json!({ "rule": "daily", "rrule": "FREQ=DAILY;BYHOUR=9" }),
            json!({ "rule": "daily", "rrule": "FREQ=DAILY;FREQ=DAILY" }),
            json!({ "rule": "daily", "rrule": "FREQ=DAILY;INTERVAL=0" }),
            json!({ "rule": "daily", "rrule": "FREQ=DAILY;UNTIL=20260230" }),
        ] {
            assert!(!valid_recurrence(&recurrence), "{recurrence:?}");
        }

        assert!(valid_recurrence(&json!({
            "rule": "daily",
            "until": "2026-12-31T23:59:59Z",
            "rrule": "FREQ=DAILY;UNTIL=20261231T235959Z"
        })));
    }

    #[test]
    fn local_api_patch_rejects_incompatible_recurrence_combinations() {
        for recurrence in [
            json!({ "rule": "weekly", "byMonthDay": [1] }),
            json!({ "rule": "weekly", "byDay": ["1MO"] }),
            json!({ "rule": "monthly", "byDay": ["MO"] }),
            json!({ "rule": "monthly", "byDay": ["1MO"], "byMonthDay": [1] }),
            json!({ "rule": "monthly", "weekStart": "MO" }),
            json!({ "rule": "daily", "byDay": ["MO"] }),
            json!({ "rule": "weekly", "rrule": "FREQ=DAILY" }),
            json!({ "rule": "weekly", "byDay": ["TU"], "rrule": "FREQ=WEEKLY;BYDAY=MO" }),
        ] {
            assert!(!valid_recurrence(&recurrence), "{recurrence:?}");
        }

        for recurrence in [
            json!({ "rule": "weekly", "byDay": ["MO", "WE"], "weekStart": "MO" }),
            json!({ "rule": "monthly", "byDay": ["-1FR"] }),
            json!({ "rule": "monthly", "byMonthDay": [1, 15] }),
            json!({
                "rule": "daily",
                "until": "2026-01-01T01:00:00+01:00",
                "rrule": "FREQ=DAILY;UNTIL=20260101T000000Z"
            }),
        ] {
            assert!(valid_recurrence(&recurrence), "{recurrence:?}");
        }
    }

    #[test]
    fn local_api_create_rejects_invalid_shapes_and_defaults_required_arrays() {
        let data = empty_local_api_data();
        for body in [
            json!({ "input": "Task", "props": "invalid" }),
            json!({ "input": "Task", "unexpected": true }),
            json!({ "input": "Task", "props": { "id": "managed" } }),
            json!({ "input": "Task", "props": { "title": "ignored" } }),
            json!({ "title": "x".repeat(MAX_TASK_TITLE_LENGTH + 1) }),
        ] {
            assert!(
                create_task_from_body(body.as_object().expect("body"), "device-a", &data).is_err(),
                "{body:?}"
            );
        }

        let task = create_task_from_body(
            json!({ "input": "Task", "props": { "description": null } })
                .as_object()
                .expect("body"),
            "device-a",
            &data,
        )
        .expect("valid task");
        assert_eq!(task.get("tags"), Some(&json!([])));
        assert_eq!(task.get("contexts"), Some(&json!([])));
        assert!(!task.contains_key("description"));

        let boundary_title = "x".repeat(MAX_TASK_TITLE_LENGTH);
        let task = create_task_from_body(
            json!({ "title": boundary_title })
                .as_object()
                .expect("body"),
            "device-a",
            &data,
        )
        .expect("maximum-length title");
        assert_eq!(task["title"].as_str(), Some(boundary_title.as_str()));
    }

    #[test]
    fn local_api_create_resolves_and_validates_container_hierarchy() {
        let data = json!({
            "tasks": [],
            "projects": [
                { "id": "project-1", "status": "active" },
                { "id": "project-2", "status": "active" }
            ],
            "sections": [
                { "id": "section-1", "projectId": "project-1" }
            ],
            "areas": [{ "id": "area-1" }],
            "settings": { "deviceId": "device-a" }
        });

        let task = create_task_from_body(
            json!({
                "input": "Section task",
                "props": { "sectionId": " section-1 ", "areaId": "area-1" }
            })
            .as_object()
            .expect("body"),
            "device-a",
            &data,
        )
        .expect("valid section assignment");
        assert_eq!(task["projectId"], "project-1");
        assert_eq!(task["sectionId"], "section-1");
        assert!(!task.contains_key("areaId"));

        for props in [
            json!({ "projectId": "missing-project" }),
            json!({ "sectionId": "missing-section" }),
            json!({ "areaId": "missing-area" }),
            json!({ "projectId": "project-2", "sectionId": "section-1" }),
        ] {
            let body = json!({ "input": "Invalid container", "props": props });
            assert!(
                create_task_from_body(body.as_object().expect("body"), "device-a", &data).is_err(),
                "{body:?}"
            );
        }
    }

    #[test]
    fn local_api_create_promotes_implicit_inbox_with_start_but_honors_explicit_status() {
        let data = empty_local_api_data();
        let implicit = create_task_from_body(
            json!({ "input": "Scheduled", "props": { "startTime": "2026-08-01" } })
                .as_object()
                .expect("body"),
            "device-a",
            &data,
        )
        .expect("implicit status task");
        assert_eq!(implicit["status"], "next");

        let explicit = create_task_from_body(
            json!({
                "input": "Explicit inbox",
                "props": { "status": "inbox", "startTime": "2026-08-01" }
            })
            .as_object()
            .expect("body"),
            "device-a",
            &data,
        )
        .expect("explicit status task");
        assert_eq!(explicit["status"], "inbox");
    }

    #[test]
    fn local_api_create_canonicalizes_reference_tasks() {
        let data = empty_local_api_data();
        let task = create_task_from_body(
            json!({
                "input": "Reference",
                "props": {
                    "status": "reference",
                    "startTime": "2026-08-01",
                    "dueDate": "2026-08-02",
                    "relativeStartOffset": { "amount": -1, "unit": "day" },
                    "reviewAt": "2026-08-03",
                    "recurrence": { "rule": "daily" },
                    "priority": "high",
                    "timeEstimate": "30min",
                    "suppressMindwtrReminders": true,
                    "repeatReminderMinutes": 15,
                    "showFutureRecurrence": true,
                    "isFocusedToday": true,
                    "focusOrder": 2,
                    "boardOrder": 4,
                    "pushCount": 3
                }
            })
            .as_object()
            .expect("body"),
            "device-a",
            &data,
        )
        .expect("reference task");

        assert_eq!(task["status"], "reference");
        assert_eq!(task["isFocusedToday"], false);
        assert_eq!(task["pushCount"], 0);
        for field in [
            "startTime",
            "dueDate",
            "relativeStartOffset",
            "reviewAt",
            "recurrence",
            "priority",
            "timeEstimate",
            "suppressMindwtrReminders",
            "repeatReminderMinutes",
            "showFutureRecurrence",
            "focusOrder",
            "boardOrder",
        ] {
            assert!(!task.contains_key(field), "{field}");
        }
    }

    #[test]
    fn local_api_create_applies_focus_eligibility_and_limit() {
        let eligible = create_task_from_body(
            json!({ "input": "Focus me", "props": { "isFocusedToday": true } })
                .as_object()
                .expect("body"),
            "device-a",
            &empty_local_api_data(),
        )
        .expect("eligible focus task");
        assert_eq!(eligible["status"], "next");
        assert_eq!(eligible["isFocusedToday"], true);

        let cap_full = json!({
            "tasks": [{
                "id": "focused",
                "status": "next",
                "isFocusedToday": true
            }],
            "projects": [],
            "sections": [],
            "areas": [],
            "settings": {
                "deviceId": "device-a",
                "gtd": { "focusTaskLimit": 1 }
            }
        });
        let refused = create_task_from_body(
            json!({
                "input": "Cap refused",
                "props": { "status": "inbox", "isFocusedToday": true }
            })
            .as_object()
            .expect("body"),
            "device-a",
            &cap_full,
        )
        .expect("refused focus task remains valid");
        assert_eq!(refused["status"], "inbox");
        assert_eq!(refused["isFocusedToday"], false);
    }

    #[test]
    fn local_api_focus_uses_local_day_at_timezone_boundaries() {
        for (offset_hours, now, start, future) in [
            (9, "2026-10-11T23:00:00Z", "2026-10-12", false),
            (9, "2026-10-11T23:00:00Z", "2026-10-12T07:00+09:00", false),
            (9, "2026-10-11T23:00:00Z", "2026-10-11T23:30:00Z", false),
            (-4, "2026-10-12T01:00:00Z", "2026-10-12", true),
            (-4, "2026-10-12T01:00:00Z", "2026-10-12T07:00", true),
            (-4, "2026-10-12T01:00:00Z", "2026-10-12T01:30:00Z", false),
            (-4, "2026-10-12T01:00:00Z", "2026-10-12T07:00+09:00", false),
        ] {
            let offset = time::UtcOffset::from_hms(offset_hours, 0, 0).unwrap();
            let local_wall = |instant: OffsetDateTime| {
                let local = instant.to_offset(offset);
                Some(PrimitiveDateTime::new(local.date(), local.time()))
            };
            let instant = OffsetDateTime::parse(now, &Rfc3339).unwrap();
            let mut task = json!({
                "status": "next", "startTime": start, "isFocusedToday": true, "focusOrder": 1
            })
            .as_object()
            .unwrap()
            .clone();
            assert_eq!(
                local_api_task_is_future_start(&task, instant, &local_wall),
                future,
                "future-start mismatch: offset={offset_hours} now={now} start={start}"
            );
            assert_eq!(
                local_api_focused_task_count(
                    &json!({"tasks": [task.clone()]}),
                    instant,
                    &local_wall
                ),
                usize::from(!future),
                "Focus count mismatch: offset={offset_hours} now={now} start={start}"
            );
            let cap_full = json!({
                "tasks": [{"status": "next", "isFocusedToday": true}],
                "settings": {"gtd": {"focusTaskLimit": 1}}
            });
            normalize_created_task_focus(&mut task, &cap_full, now, &local_wall);
            assert_eq!(
                task["isFocusedToday"], future,
                "Focus cap mismatch: {start}"
            );
            assert_eq!(task.contains_key("focusOrder"), future);
        }

        let utc_unavailable = |_| None;
        let now = OffsetDateTime::parse("2026-10-12T01:00:00+09:00", &Rfc3339).unwrap();
        for start in ["2026-10-12", "2026-10-11T23:30:00-04:00"] {
            let task = json!({"startTime": start});
            assert!(local_api_task_is_future_start(
                task.as_object().unwrap(),
                now,
                &utc_unavailable
            ));
        }
    }

    #[test]
    fn local_api_create_queues_future_focus_without_consuming_limit() {
        let cap_full = json!({
            "tasks": [{
                "id": "focused",
                "status": "next",
                "isFocusedToday": true
            }],
            "projects": [],
            "sections": [],
            "areas": [],
            "settings": {
                "deviceId": "device-a",
                "gtd": { "focusTaskLimit": 1 }
            }
        });
        let future = create_task_from_body(
            json!({
                "input": "Future",
                "props": {
                    "status": "inbox",
                    "startTime": "9999-12-31",
                    "isFocusedToday": true
                }
            })
            .as_object()
            .expect("body"),
            "device-a",
            &cap_full,
        )
        .expect("future task");
        assert_eq!(future["status"], "next");
        assert_eq!(future["isFocusedToday"], true);

        let queued_only = json!({
            "tasks": (0..3).map(|index| json!({
                "id": format!("queued-{index}"),
                "status": "next",
                "startTime": "9999-12-31",
                "isFocusedToday": true
            })).collect::<Vec<_>>(),
            "projects": [],
            "sections": [],
            "areas": [],
            "settings": {
                "deviceId": "device-a",
                "gtd": { "focusTaskLimit": 1 }
            }
        });
        let today = create_task_from_body(
            json!({ "input": "Today", "props": { "isFocusedToday": true } })
                .as_object()
                .expect("body"),
            "device-a",
            &queued_only,
        )
        .expect("today task");
        assert_eq!(today["status"], "next");
        assert_eq!(today["isFocusedToday"], true);
    }

    #[test]
    fn local_api_create_rejects_ineligible_focus_without_reclassifying() {
        let inactive_project = json!({
            "tasks": [],
            "projects": [{
                "id": "project-inactive",
                "status": "someday"
            }],
            "sections": [],
            "areas": [],
            "settings": { "deviceId": "device-a" }
        });
        let unavailable = create_task_from_body(
            json!({
                "input": "Unavailable project",
                "props": {
                    "status": "next",
                    "projectId": "project-inactive",
                    "isFocusedToday": true
                }
            })
            .as_object()
            .expect("body"),
            "device-a",
            &inactive_project,
        )
        .expect("project task");
        assert_eq!(unavailable["status"], "next");
        assert_eq!(unavailable["isFocusedToday"], false);

        let sequential = json!({
            "tasks": [{
                "id": "first",
                "title": "First",
                "status": "next",
                "projectId": "project-1",
                "createdAt": "2020-01-01T00:00:00Z"
            }],
            "projects": [{
                "id": "project-1",
                "status": "active",
                "isSequential": true
            }],
            "sections": [],
            "areas": [],
            "settings": { "deviceId": "device-a" }
        });
        let blocked = create_task_from_body(
            json!({
                "input": "Later",
                "props": {
                    "status": "next",
                    "projectId": "project-1",
                    "isFocusedToday": true
                }
            })
            .as_object()
            .expect("body"),
            "device-a",
            &sequential,
        )
        .expect("sequential task");
        assert_eq!(blocked["status"], "next");
        assert_eq!(blocked["isFocusedToday"], false);
    }

    #[test]
    fn unsupported_local_api_fields_are_bad_requests() {
        assert_eq!(
            api_error_response("Unsupported task field: unknown".to_string()).status,
            400
        );
    }

    /// Companion to the task parity test below. Without it, adding a cloud-writable project
    /// field to the schema silently leaves the local API answering 400 for it. Every
    /// cloud-writable field must be either accepted or listed here with a reason.
    #[test]
    fn local_api_project_allowlist_matches_project_sync_schema() {
        // Owned by the merge engine / tombstone lifecycle — never a client write.
        const DELIBERATELY_DENIED: [&str; 5] = [
            "deletedAt",
            "purgedAt",
            "cancelledAt",
            "attachments",
            "areaTitle",
        ];
        // Cloud-writable in the schema, but the local API project routes do not implement them
        // yet. This is a known gap, not a decision: adding one to the allowlist is a deliberate
        // change and must move the name out of this list.
        const NOT_IMPLEMENTED: [&str; 8] = [
            "tagIds",
            "taskSortBy",
            "isFocused",
            "supportNotes",
            "dueDate",
            "reviewAt",
            "startDate",
            "viewSectionIds",
        ];

        let schema: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/project-sync-schema.fixture.json"
        ))
        .expect("valid project schema fixture");
        let fixture = schema["fixture"].as_object().expect("fixture object");
        for field in schema["fields"].as_array().expect("schema fields") {
            let name = field["name"].as_str().expect("field name");
            let cloud_write = field["cloudWrite"].as_str().expect("cloud write mode");
            if !matches!(cloud_write, "create-patch" | "patch") {
                continue;
            }
            let patch = Map::from_iter([(
                name.to_string(),
                fixture
                    .get(name)
                    .cloned()
                    .expect("fixture covers every field"),
            )]);
            let expected = !DELIBERATELY_DENIED.contains(&name) && !NOT_IMPLEMENTED.contains(&name);
            let result = sanitize_project_fields(&patch, true);
            assert_eq!(
                result.is_ok(),
                expected,
                "Local API project write parity for {name}"
            );
            if !expected {
                let error = result.unwrap_err();
                assert!(
                    error.starts_with("Unsupported project field"),
                    "{name}: {error}"
                );
            }
        }
    }

    #[test]
    fn local_api_patch_allowlist_matches_task_sync_schema() {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/task-sync-schema.fixture.json"
        ))
        .expect("valid task schema fixture");
        let fixture = schema["fixture"].as_object().expect("fixture object");
        for field in schema["fields"].as_array().expect("schema fields") {
            let name = field["name"].as_str().expect("field name");
            let cloud_write = field["cloudWrite"].as_str().expect("cloud write mode");
            let mut patch = Map::from_iter([(
                name.to_string(),
                fixture
                    .get(name)
                    .cloned()
                    .expect("fixture covers every field"),
            )]);
            let writable = matches!(cloud_write, "create-patch" | "patch");
            assert_eq!(
                sanitize_task_patch_map(&mut patch).is_ok(),
                writable,
                "Local API write parity for {name}"
            );
        }
    }

    #[test]
    fn cancellation_patch_preserves_history_and_stops_recurrence() {
        let mut task = json!({
            "id": "cancel-series", "title": "Weekly action", "status": "next",
            "description": "Keep this history", "isFocusedToday": true,
            "focusOrder": 2, "boardOrder": 4, "rev": 3,
            "recurrence": { "rule": "weekly", "seriesId": "cancel-series" }
        })
        .as_object()
        .unwrap()
        .clone();
        let patch = json!({"cancelledAt": "2026-09-07T12:00:00.000Z"});
        apply_task_patch(&mut task, patch.as_object().unwrap(), "device-a").unwrap();
        assert_eq!(task["status"], "archived");
        let archived_at = task["archivedAt"]
            .as_str()
            .expect("archive clock")
            .to_string();
        assert!(valid_cancellation_timestamp(task.get("archivedAt")));
        assert_eq!(task["cancelledAt"], "2026-09-07T12:00:00.000Z");
        assert_eq!(task["description"], "Keep this history");
        assert_eq!(task["recurrence"]["rule"], "weekly");
        assert_eq!(task["isFocusedToday"], false);
        assert!(!task.contains_key("completedAt"));
        assert!(!task.contains_key("focusOrder"));
        assert!(!task.contains_key("boardOrder"));
        assert_eq!(task["rev"], 4);

        // A later notes edit must not turn cancellation into completion.
        apply_task_patch(
            &mut task,
            json!({"description": "Reason added"}).as_object().unwrap(),
            "device-a",
        )
        .unwrap();
        assert!(!task.contains_key("completedAt"));
        assert!(task.contains_key("cancelledAt"));
        assert_eq!(task["archivedAt"], archived_at);

        // Correcting the outcome to Completed clears cancellation and does not
        // create another recurring occurrence from an already archived item.
        let follow_up = apply_task_action(
            &mut task,
            "complete",
            "archived",
            "2026-09-08T12:00:00.000Z",
            "device-a",
            &LiveContainers::default(),
        )
        .unwrap();
        assert!(follow_up.is_none());
        assert_eq!(task["status"], "done");
        assert!(!task.contains_key("cancelledAt"));
        assert!(!task.contains_key("archivedAt"));
        assert_eq!(task["completedAt"], "2026-09-08T12:00:00.000Z");
    }

    #[test]
    fn cancellation_creation_and_timestamp_validation() {
        let body = json!({"title": "Closed action", "props": {"cancelledAt": "2026-09-07T12:00:00.000Z", "isFocusedToday": true}});
        let task =
            create_task_from_body(body.as_object().unwrap(), "device-a", &json!({})).unwrap();
        assert_eq!(task["status"], "archived");
        assert!(valid_cancellation_timestamp(task.get("archivedAt")));
        assert_eq!(task["isFocusedToday"], false);
        assert!(!task.contains_key("completedAt"));
        for value in [
            json!("2026-09-07"),
            json!("tomorrow"),
            json!(42),
            json!("2026-02-30T12:00:00Z"),
        ] {
            let mut patch = Map::from_iter([("cancelledAt".to_string(), value)]);
            assert!(sanitize_task_patch_map(&mut patch).is_err());
        }
        let mut backdated =
            Map::from_iter([("archivedAt".to_string(), json!("2000-01-01T00:00:00Z"))]);
        assert!(sanitize_task_patch_map(&mut backdated).is_err());
    }

    #[test]
    fn local_api_archive_clock_reenters_and_rejects_project_backdating() {
        let mut task = json!({"id":"task", "title":"Task", "status":"next", "rev":1})
            .as_object()
            .unwrap()
            .clone();
        apply_task_action(
            &mut task,
            "archive",
            "next",
            "2026-09-01T00:00:00Z",
            "device-a",
            &LiveContainers::default(),
        )
        .unwrap();
        assert_eq!(task["archivedAt"], "2026-09-01T00:00:00Z");
        apply_task_action(
            &mut task,
            "complete",
            "archived",
            "2026-09-02T00:00:00Z",
            "device-a",
            &LiveContainers::default(),
        )
        .unwrap();
        assert!(task.get("archivedAt").is_none());
        apply_task_action(
            &mut task,
            "archive",
            "done",
            "2026-09-03T00:00:00Z",
            "device-a",
            &LiveContainers::default(),
        )
        .unwrap();
        assert_eq!(task["archivedAt"], "2026-09-03T00:00:00Z");

        let mut data = json!({"tasks":[], "projects":[], "sections":[], "areas":[], "settings":{"deviceId":"device-a"}});
        let project = create_project_from_body(
            json!({"title":"Archive","props":{"status":"archived"}})
                .as_object()
                .unwrap(),
            &data,
        )
        .unwrap();
        assert_eq!(project["status"], "archived");
        assert!(valid_cancellation_timestamp(project.get("archivedAt")));
        data["projects"] = json!([project]);
        let id = data["projects"][0]["id"].as_str().unwrap().to_string();
        assert!(patch_project_in_data(
            &mut data,
            &id,
            json!({"archivedAt":"2000-01-01T00:00:00Z"})
                .as_object()
                .unwrap()
        )
        .is_err());
        data["projects"][0]["archivedAt"] = json!("2026-09-01T00:00:00Z");
        let old_clock = data["projects"][0]["archivedAt"].clone();
        patch_project_in_data(
            &mut data,
            &id,
            json!({"status":"active"}).as_object().unwrap(),
        )
        .unwrap();
        assert!(data["projects"][0].get("archivedAt").is_none());
        patch_project_in_data(
            &mut data,
            &id,
            json!({"status":"archived"}).as_object().unwrap(),
        )
        .unwrap();
        assert!(valid_cancellation_timestamp(
            data["projects"][0].get("archivedAt")
        ));
        assert_ne!(data["projects"][0]["archivedAt"], old_clock);
    }

    #[test]
    fn task_patch_drops_malformed_existing_cancellation_timestamp() {
        let mut task = json!({
            "id": "cancelled-task", "title": "Closed action", "status": "archived",
            "cancelledAt": "2026-02-30T12:00:00Z",
            "completedAt": "2026-02-28T12:00:00Z", "rev": 3
        })
        .as_object()
        .expect("task object")
        .clone();

        apply_task_patch(
            &mut task,
            json!({ "description": "Keep the completion" })
                .as_object()
                .expect("task patch"),
            "device-a",
        )
        .expect("patch succeeds");

        assert!(!task.contains_key("cancelledAt"));
        assert_eq!(task["completedAt"], "2026-02-28T12:00:00Z");
    }

    #[test]
    fn task_restore_refuses_a_purged_task_and_leaves_it_untouched() {
        let mut task = json!({
            "id": "purged-task", "title": "", "status": "inbox", "rev": 4,
            "deletedAt": "2026-09-01T00:00:00Z", "purgedAt": "2026-09-01T00:00:00Z"
        })
        .as_object()
        .expect("task object")
        .clone();
        let before = task.clone();

        let error = apply_task_action(
            &mut task,
            "restore",
            "inbox",
            "2026-09-08T12:00:00Z",
            "device-a",
            &LiveContainers::default(),
        )
        .expect_err("purged task restore is refused");

        assert_eq!(
            error,
            "Task status conflict: purged task cannot be restored"
        );
        assert_eq!(task, before);
        assert_eq!(api_error_response(error).status, 409);
    }

    /// The project counterpart to
    /// `local_api_apply_task_action_matches_core_write_path_fixture`: drives
    /// `apply_project_delete_or_restore_at` against the shared fixture's
    /// `kind: "project-action"` cases, whose `expected` rows are independently
    /// pinned against core's real `deleteProject`/`restoreProject` in
    /// packages/core/src/local-api-project-action-parity.test.ts (which also
    /// owns the case roster).
    #[test]
    fn local_api_project_delete_or_restore_matches_core_fixture() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/recurrence-local-api-parity.fixtures.json"
        ))
        .expect("valid recurrence parity fixture");
        let cases = cases.as_array().expect("fixture array");

        for test_case in cases {
            if test_case.get("kind").and_then(Value::as_str) != Some("project-action") {
                continue;
            }
            let name = test_case
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unnamed project action parity case");
            let mut data = test_case
                .get("data")
                .cloned()
                .unwrap_or_else(|| panic!("missing data for {name}"));
            let before = data.clone();
            let project_id = test_case
                .get("projectId")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("missing projectId for {name}"));
            let restore = match test_case.get("action").and_then(Value::as_str) {
                Some("restore") => true,
                Some("delete") => false,
                other => panic!("{name}: unsupported project action {other:?}"),
            };
            let now = test_case
                .get("now")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("missing now for {name}"));
            let device_id = test_case
                .get("deviceId")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("missing deviceId for {name}"));

            let outcome =
                apply_project_delete_or_restore_at(&mut data, project_id, restore, now, device_id);

            if test_case.get("expectRefusal").and_then(Value::as_bool) == Some(true) {
                let error = outcome.expect_err(name);
                assert_eq!(
                    error, "Project update conflict: purged project cannot be changed",
                    "{name}"
                );
                assert_eq!(data, before, "{name}: refused action must not write");
                continue;
            }

            let changed = outcome.unwrap_or_else(|error| panic!("{name}: {error}"));
            let expected = test_case
                .get("expected")
                .cloned()
                .unwrap_or_else(|| json!({}));
            for (key, rows) in [
                ("projects", &changed.projects),
                ("sections", &changed.sections),
                ("tasks", &changed.tasks),
            ] {
                let expected_rows = expected.get(key).cloned().unwrap_or_else(|| json!([]));
                assert_eq!(
                    Value::Array(rows.clone()),
                    expected_rows,
                    "{name}: changed {key} mismatch"
                );
            }
        }
    }

    fn comparable_local_api_recurring_task(task: Option<Map<String, Value>>) -> Value {
        let Some(mut task) = task else {
            return Value::Null;
        };
        // `id` is a fresh random UUID minted independently by each engine
        // (TS's createNextRecurringTask and this Rust port each call their own
        // uuid generator) - the one legitimately platform/run-variant field,
        // so it is excluded rather than compared. Every other key is real
        // full-task equality against the fixture's `expected`/`localApiExpected`.
        task.remove("id");
        Value::Object(task)
    }

    #[test]
    fn local_api_recurring_task_matches_core_golden_fixture() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/recurrence-local-api-parity.fixtures.json"
        ))
        .expect("valid recurrence parity fixture");
        let cases = cases.as_array().expect("fixture array");

        for test_case in cases {
            // The same fixture file also carries `kind: "action"` and
            // `kind: "project-action"` cases (task and project write-path
            // parity), asserted by their own tests - this test only owns the
            // recurrence-only cases, which predate the `kind` field, so its
            // absence means "recurrence". Mirrors recurrence.test.ts's filter.
            if test_case
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind != "recurrence")
            {
                continue;
            }
            let name = test_case
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("unnamed recurrence parity case");
            let task = test_case
                .get("task")
                .and_then(|value| value.as_object())
                .unwrap_or_else(|| panic!("missing task object for {name}"));
            let completed_at = test_case
                .get("completedAt")
                .and_then(|value| value.as_str())
                .unwrap_or_else(|| panic!("missing completedAt for {name}"));
            let previous_status = test_case
                .get("previousStatus")
                .and_then(|value| value.as_str())
                .unwrap_or_else(|| panic!("missing previousStatus for {name}"));
            // `localApiExpected` is an optional, Rust-only override: recurrence.ts
            // (the correct engine) and this local API deliberately diverge on
            // byDay/byMonthDay/rrule cases — core computes the real next date,
            // this engine refuses (None) rather than guess. `expected` still
            // pins core's real answer via recurrence.test.ts unchanged;
            // `localApiExpected`, when present, is what this engine must produce.
            let expected = test_case
                .get("localApiExpected")
                .or_else(|| test_case.get("expected"))
                .unwrap_or_else(|| panic!("missing expected snapshot for {name}"));

            let actual = comparable_local_api_recurring_task(
                create_next_recurring_task_for_local_api(task, completed_at, previous_status),
            );
            assert_eq!(&actual, expected, "{name}");
        }
    }

    #[test]
    fn local_api_start_catchup_refusal_preserves_source_and_supported_completions() {
        let completed = "2026-08-13T12:00:00.000Z";
        let local_day =
            crate::local_query::local_wall(OffsetDateTime::parse(completed, &Rfc3339).unwrap())
                .unwrap()
                .date()
                .to_string();
        let base = json!({ "id": "late-start", "title": "Recurring", "status": "next",
            "startTime": "2000-01-01", "recurrence": "daily", "tags": [], "contexts": [] });
        assert!(recurrence_start_needs_catchup(
            base.as_object().unwrap(),
            completed
        ));
        let mut data = json!({ "tasks": [base.clone()] });
        let before = data.clone();
        let result = mutate_task_operation(
            &mut data,
            &LocalOperation::TaskAction {
                id: "late-start".to_string(),
                action: "complete".to_string(),
            },
        );
        assert_eq!(result.unwrap_err(), RECURRENCE_REQUIRES_APP);
        assert_eq!(data, before);
        let patch = json!({ "status": "done" });
        assert!(patch_task_in_data(&mut data, "late-start", patch.as_object().unwrap()).is_err());
        assert_eq!(data, before);

        for (start, needs_app) in [
            ("2026-08-12T12:00:00.000Z", true),
            ("2026-08-12T12:00:00.001Z", false),
            ("2100-01-01", false),
        ] {
            let mut task = base.as_object().unwrap().clone();
            task.insert("startTime".into(), json!(start));
            assert_eq!(
                recurrence_start_needs_catchup(&task, completed),
                needs_app,
                "{start}"
            );
        }
        // A one-step date-only candidate on local today remains supported.
        let (year, month, day, _) = parse_iso_prefix(&local_day).unwrap();
        let (year, month, day) = add_days(year, month, day, -1);
        let mut task = base.as_object().unwrap().clone();
        task.insert(
            "startTime".into(),
            json!(format!("{year:04}-{month:02}-{day:02}")),
        );
        assert!(!recurrence_start_needs_catchup(&task, completed));
        for update in [
            json!({ "dueDate": "2000-01-01" }),
            json!({ "recurrence": { "rule": "daily", "strategy": "fluid" } }),
            json!({ "recurrence": { "rule": "daily", "count": 1 } }),
            json!({ "recurrence": { "rule": "daily", "until": "2000-01-01" } }),
        ] {
            let mut task = base.as_object().unwrap().clone();
            task.extend(update.as_object().unwrap().clone());
            assert!(!recurrence_start_needs_catchup(&task, completed));
        }
        task = base.as_object().unwrap().clone();
        task.insert("recurrence".into(), json!({ "rule": "daily", "count": 1 }));
        assert!(create_next_recurring_task_for_local_api(&task, completed, "next").is_none());
        assert!(recurrence_completion_refusal(
            &json!({ "tasks": [task] }),
            "late-start",
            completed
        )
        .is_none());
        let mixed_offset = json!({ "id": "late-start", "status": "next",
            "startTime": "2026-08-10T12:00:00+14:00",
            "recurrence": { "rule": "daily", "until": "2026-08-11T11:00:00-12:00" } });
        assert!(recurrence_start_needs_catchup(
            mixed_offset.as_object().unwrap(),
            "2026-08-10T23:00:00Z"
        ));
        assert!(recurrence_completion_refusal(
            &json!({ "tasks": [mixed_offset] }),
            "late-start",
            "2026-08-10T23:00:00Z"
        )
        .is_some());
    }

    #[test]
    fn local_api_complete_creates_next_recurring_task_payload() {
        let task = json!({
            "id": "task-1",
            "title": "Water plants",
            "status": "next",
            "dueDate": "2026-06-14",
            "recurrence": { "rule": "daily", "count": 3, "completedOccurrences": 0 },
            "tags": ["#home"],
            "contexts": ["@home"],
            "checklist": [
                { "id": "item-1", "title": "Kitchen", "isCompleted": true }
            ],
            "createdAt": "2026-06-01T00:00:00Z",
            "updatedAt": "2026-06-01T00:00:00Z"
        });
        let next = create_next_recurring_task_for_local_api(
            task.as_object().expect("task object"),
            "2026-06-14T12:00:00Z",
            "next",
        )
        .expect("next recurring task");

        assert_ne!(
            next.get("id").and_then(|value| value.as_str()),
            Some("task-1")
        );
        assert_eq!(
            next.get("status").and_then(|value| value.as_str()),
            Some("next")
        );
        assert_eq!(
            next.get("dueDate").and_then(|value| value.as_str()),
            Some("2026-06-15")
        );
        assert_eq!(
            next.get("recurrence")
                .and_then(|value| value.get("completedOccurrences"))
                .and_then(|value| value.as_i64()),
            Some(1)
        );
        assert_eq!(
            next.get("recurrence")
                .and_then(|value| value.get("seriesId"))
                .and_then(|value| value.as_str()),
            Some("task-1")
        );
        let checklist = next
            .get("checklist")
            .and_then(|value| value.as_array())
            .expect("checklist");
        assert_eq!(
            checklist[0]
                .get("isCompleted")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_ne!(
            checklist[0].get("id").and_then(|value| value.as_str()),
            Some("item-1")
        );
    }

    #[test]
    fn local_api_complete_does_not_repeat_done_recurring_tasks() {
        assert!(should_create_recurring_follow_up("complete", "next"));
        // archived -> done is a lifecycle correction (mirrors core's
        // `isReturningFromArchive` in applyTaskUpdates): no new occurrence.
        assert!(!should_create_recurring_follow_up("complete", "archived"));
        assert!(!should_create_recurring_follow_up("complete", "done"));
        assert!(!should_create_recurring_follow_up("archive", "next"));
    }

    #[test]
    fn local_api_recurring_task_stops_when_count_is_exhausted() {
        let task = json!({
            "id": "task-1",
            "title": "Water plants",
            "status": "next",
            "dueDate": "2026-06-14",
            "recurrence": { "rule": "daily", "count": 1, "completedOccurrences": 0 },
            "tags": [],
            "contexts": []
        });

        assert!(create_next_recurring_task_for_local_api(
            task.as_object().expect("task object"),
            "2026-06-14T12:00:00Z",
            "next",
        )
        .is_none());
    }

    #[test]
    fn local_api_complete_does_not_refuse_archived_correction_even_with_complex_recurrence() {
        // archived -> done never spawns a follow-up (it's a correction, not a
        // completion), so it must never be refused either, even for a
        // recurrence this engine could not otherwise compute a next date for.
        let data = json!({
            "tasks": [{
                "id": "byday-archived",
                "title": "Standup",
                "status": "archived",
                "completedAt": "2026-07-01T00:00:00.000Z",
                "recurrence": { "rule": "weekly", "byDay": ["MO", "WE", "FR"] }
            }]
        });
        assert!(
            recurrence_completion_refusal(&data, "byday-archived", "2026-07-20T12:00:00.000Z")
                .is_none()
        );
    }

    /// Consolidation-law pin: a test that only iterates `kind: "action"`
    /// cases can't catch the fixture shrinking - deleting a case would
    /// silently narrow the loop right along with the bug it stopped
    /// covering. This roster mirrors the independent, hand-written list in
    /// packages/core/src/local-api-action-parity.test.ts; removing a case
    /// from the JSON without removing it in both places fails here.
    #[test]
    fn local_api_action_fixture_matches_pinned_case_roster() {
        const PINNED_ACTION_CASE_NAMES: &[&str] = &[
            "complete a non-recurring task",
            "complete a recurring task creates a follow-up with rev/revBy stamped",
            "completing an archived task is a correction, not a new completion",
            "archive a task",
            "restore drops a dangling projectId and sectionId but keeps a live areaId",
            "complete refuses recurrence the local API engine cannot compute (409)",
            "completing an already-done task is a full no-op",
            "complete refuses recurrence with a relativeStartOffset the local API can't recompute (409)",
            "restore: section adopts its project and clears area",
            "restore: section dropped when it belongs to another project",
            "restore: area dropped when project set",
        ];

        let cases: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/recurrence-local-api-parity.fixtures.json"
        ))
        .expect("valid recurrence parity fixture");
        let cases = cases.as_array().expect("fixture array");

        let mut actual_names: Vec<&str> = cases
            .iter()
            .filter(|case| case.get("kind").and_then(Value::as_str) == Some("action"))
            .map(|case| {
                case.get("name")
                    .and_then(Value::as_str)
                    .expect("action case name")
            })
            .collect();
        actual_names.sort_unstable();
        let mut expected_names = PINNED_ACTION_CASE_NAMES.to_vec();
        expected_names.sort_unstable();

        assert_eq!(actual_names, expected_names);
    }

    /// The write-path counterpart to `local_api_recurring_task_matches_core_golden_fixture`:
    /// exercises `apply_task_action` (complete/archive/restore, plus the 409
    /// refusal) against the same shared fixture's `kind: "action"` cases,
    /// whose `expectedTask`/`expectedFollowUp` are independently pinned
    /// against core's real `applyTaskUpdates`/`nextRevision` in
    /// packages/core/src/local-api-action-parity.test.ts.
    #[test]
    fn local_api_apply_task_action_matches_core_write_path_fixture() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/recurrence-local-api-parity.fixtures.json"
        ))
        .expect("valid recurrence parity fixture");
        let cases = cases.as_array().expect("fixture array");

        for test_case in cases {
            if test_case.get("kind").and_then(Value::as_str) != Some("action") {
                continue;
            }
            let name = test_case
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unnamed action parity case");

            if test_case.get("expectRefusal").and_then(Value::as_bool) == Some(true) {
                let task = test_case.get("task").cloned().unwrap_or(Value::Null);
                let task_id = task
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let data = json!({ "tasks": [task] });
                let refusal =
                    recurrence_completion_refusal(&data, &task_id, "2026-07-20T12:00:00.000Z")
                        .unwrap_or_else(|| panic!("{name}: expected a 409 refusal"));
                assert_eq!(refusal.status, 409, "{name}");
                assert_eq!(
                    refusal.body.get("code").and_then(Value::as_str),
                    Some("recurrence_requires_app"),
                    "{name}"
                );
                continue;
            }

            let action = test_case
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("missing action for {name}"));
            let previous_status = test_case
                .get("previousStatus")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("missing previousStatus for {name}"));
            let now = test_case
                .get("now")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("missing now for {name}"));
            let device_id = test_case
                .get("deviceId")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("missing deviceId for {name}"));
            let mut task = test_case
                .get("task")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_else(|| panic!("missing task for {name}"));
            let containers_data = test_case
                .get("containers")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let live_containers = LiveContainers::from_data(&containers_data);

            let expected_task = test_case
                .get("expectedTask")
                .cloned()
                .unwrap_or_else(|| panic!("missing expectedTask for {name}"));
            let expected_follow_up = test_case
                .get("expectedFollowUp")
                .cloned()
                .unwrap_or(Value::Null);

            let follow_up = apply_task_action(
                &mut task,
                action,
                previous_status,
                now,
                device_id,
                &live_containers,
            )
            .unwrap_or_else(|error| panic!("{name}: apply_task_action failed: {error}"));

            assert_eq!(Value::Object(task), expected_task, "{name}: task mismatch");

            match follow_up {
                Some(mut next_task) => {
                    // `id` is a fresh random uuid - the one legitimately
                    // platform/run-variant field.
                    next_task.remove("id");
                    assert_eq!(
                        Value::Object(next_task),
                        expected_follow_up,
                        "{name}: follow-up mismatch"
                    );
                }
                None => {
                    assert_eq!(
                        Value::Null,
                        expected_follow_up,
                        "{name}: expected no follow-up"
                    );
                }
            }
        }
    }

    #[test]
    fn local_api_project_creation_matches_core_factory_defaults() {
        let mut data = json!({
            "tasks": [],
            "projects": [],
            "sections": [],
            "areas": [{ "id": "area-1", "name": " Work ", "deletedAt": null }],
            "people": [],
            "settings": {
                "deviceId": "device-project",
                "gtd": { "defaultProjectFlowMode": "sequential" }
            }
        });
        data[PROJECT_MUTATION_NEXT_ORDER_KEY] = json!(4.5);
        let body = json!({
            "title": "  Launch  ",
            "props": { "areaId": " area-1 ", "sequentialScope": "section" }
        });

        let project = create_project_from_body(body.as_object().unwrap(), &data)
            .expect("valid project creation");

        assert_eq!(project["title"], "Launch");
        assert_eq!(project["status"], "active");
        assert_eq!(project["color"], DEFAULT_PROJECT_COLOR);
        assert_eq!(project["order"], 4.5);
        assert_eq!(project["tagIds"], json!([]));
        assert_eq!(project["isSequential"], true);
        assert_eq!(project["sequentialScope"], "section");
        assert_eq!(project["isFocused"], false);
        assert_eq!(project["areaId"], "area-1");
        assert_eq!(project["areaTitle"], "Work");
        assert_eq!(project["rev"], 1);
        assert_eq!(project["revBy"], "device-project");
        assert!(project["id"].as_str().is_some_and(|id| !id.is_empty()));
        assert!(project["createdAt"].is_string());
        assert_eq!(project["createdAt"], project["updatedAt"]);
    }

    #[test]
    fn local_api_project_validation_is_strict_and_atomic() {
        let mut data = json!({
            "tasks": [], "sections": [], "areas": [], "people": [],
            "projects": [{
                "id": "project-1", "title": "Original", "status": "active",
                "color": "#000", "order": 0, "tagIds": [], "isSequential": false,
                "createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z",
                "rev": 7, "revBy": "device-a"
            }],
            "settings": { "deviceId": "device-a" }
        });
        data[PROJECT_MUTATION_NEXT_ORDER_KEY] = json!(1);
        let original = data.clone();

        for patch in [
            json!({ "title": null }),
            json!({ "color": "" }),
            json!({ "status": "done" }),
            json!({ "isSequential": "yes" }),
            json!({ "sequentialScope": "workspace" }),
            json!({ "order": null }),
            json!({ "areaId": "" }),
            json!({ "rev": 99 }),
            json!({}),
        ] {
            let error = patch_project_in_data(&mut data, "project-1", patch.as_object().unwrap())
                .expect_err("invalid project patch");
            assert_eq!(api_error_response(error).status, 400, "{patch}");
            assert_eq!(data, original, "invalid patch must be atomic: {patch}");
        }

        data["projects"][0]["deletedAt"] = json!("2026-09-02T00:00:00Z");
        let deleted = data.clone();
        let error = patch_project_in_data(
            &mut data,
            "project-1",
            json!({ "title": "Changed" }).as_object().unwrap(),
        )
        .expect_err("deleted project cannot be updated");
        assert_eq!(api_error_response(error).status, 409);
        assert_eq!(data, deleted);
    }

    #[test]
    fn local_api_project_archive_and_reactivation_match_core_child_lifecycle() {
        let created_at = "2026-09-01T00:00:00Z";
        let mut data = json!({
            "tasks": [
                {
                    "id": "next", "title": "Next", "status": "next", "projectId": "project-1",
                    "sectionId": "section-1", "isFocusedToday": true, "focusOrder": 1,
                    "boardOrder": 8, "recurrence": { "rule": "daily", "seriesId": "next" },
                    "tags": [], "contexts": [], "rev": 3, "revBy": "old",
                    "createdAt": created_at, "updatedAt": created_at
                },
                {
                    "id": "waiting", "title": "Waiting", "status": "waiting", "projectId": "project-1",
                    "tags": [], "contexts": [], "rev": 2, "revBy": "old",
                    "createdAt": created_at, "updatedAt": created_at
                },
                {
                    "id": "reference", "title": "Reference", "status": "reference", "projectId": "project-1",
                    "sectionId": "section-1", "tags": [], "contexts": [], "rev": 1,
                    "createdAt": created_at, "updatedAt": created_at
                },
                {
                    "id": "independent", "title": "Independent", "status": "archived", "projectId": "project-1",
                    "archivedAt": "2026-08-01T00:00:00Z", "tags": [], "contexts": [], "rev": 1,
                    "createdAt": created_at, "updatedAt": created_at
                }
            ],
            "projects": [{
                "id": "project-1", "title": "Project", "status": "active", "color": "#000",
                "order": 0, "tagIds": [], "isSequential": false, "isFocused": true,
                "rev": 4, "revBy": "old", "createdAt": created_at, "updatedAt": created_at
            }],
            "sections": [{
                "id": "section-1", "projectId": "project-1", "title": "Section", "order": 0,
                "rev": 2, "revBy": "old", "createdAt": created_at, "updatedAt": created_at
            }],
            "areas": [], "people": [], "settings": { "deviceId": "device-a" }
        });
        data[PROJECT_MUTATION_NEXT_ORDER_KEY] = json!(1);
        let original_reference = data["tasks"][2].clone();

        let (_, archived_tasks, archived_sections) = patch_project_in_data(
            &mut data,
            "project-1",
            json!({ "status": "archived" }).as_object().unwrap(),
        )
        .expect("archive project");

        assert_eq!(archived_tasks.len(), 3);
        assert_eq!(archived_sections.len(), 1);
        assert_eq!(
            data["tasks"].as_array().unwrap().len(),
            4,
            "no recurrence follow-up"
        );
        assert_eq!(data["tasks"][0]["status"], "done");
        assert_eq!(data["tasks"][0]["statusBeforeProjectArchive"], "next");
        assert_eq!(data["tasks"][0]["recurrence"]["seriesId"], "next");
        assert_eq!(data["tasks"][0]["boardOrder"], 8);
        assert!(data["tasks"][0].get("focusOrder").is_none());
        assert_eq!(data["tasks"][0]["isFocusedToday"], false);
        assert_eq!(data["tasks"][2]["status"], original_reference["status"]);
        let archived_at = data["projects"][0]["updatedAt"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(data["projects"][0]["archivedAt"], archived_at);
        for task in data["tasks"].as_array().unwrap().iter().take(3) {
            assert_eq!(task["archivedAt"], archived_at);
        }
        assert_eq!(data["tasks"][3]["archivedAt"], "2026-08-01T00:00:00Z");
        assert_eq!(data["sections"][0]["deletedAt"], archived_at);
        assert_eq!(data["sections"][0]["projectArchivedAt"], archived_at);

        data["tasks"][1]["updatedAt"] = json!("2099-01-01T00:00:00Z");
        data["tasks"][1]["rev"] = json!(99);
        let (_, restored_tasks, restored_sections) = patch_project_in_data(
            &mut data,
            "project-1",
            json!({ "status": "active" }).as_object().unwrap(),
        )
        .expect("reactivate project");

        assert_eq!(
            restored_tasks.len(),
            3,
            "children stamped by this archive lose that clock even if edited"
        );
        assert_eq!(restored_sections.len(), 1);
        assert_eq!(data["tasks"][0]["status"], "next");
        assert_eq!(data["tasks"][0]["isFocusedToday"], true);
        assert!(data["tasks"][0].get("projectArchivedAt").is_none());
        assert!(data["tasks"][0].get("archivedAt").is_none());
        assert_eq!(data["tasks"][1]["status"], "done");
        assert_eq!(data["tasks"][1]["rev"], 100);
        assert!(data["tasks"][1].get("archivedAt").is_none());
        assert!(data["tasks"][2].get("archivedAt").is_none());
        assert_eq!(data["tasks"][3]["archivedAt"], "2026-08-01T00:00:00Z");
        assert!(data["projects"][0].get("archivedAt").is_none());
        assert!(data["sections"][0].get("deletedAt").is_none());
        assert!(data["sections"][0].get("projectArchivedAt").is_none());
    }

    #[test]
    fn local_api_project_lifecycle_includes_section_only_children_without_crossing_owner() {
        let at = "2026-09-01T00:00:00Z";
        let mut data = json!({
            "tasks": [
                {"id":"direct","title":"Direct","status":"next","projectId":"project-1","rev":1,"updatedAt":at},
                {"id":"section-only","title":"Section only","status":"next","sectionId":"section-1","rev":1,"updatedAt":at},
                {"id":"empty-owner","title":"Empty owner","status":"waiting","projectId":"","sectionId":"section-1","rev":1,"updatedAt":at},
                {"id":"reference","title":"Reference","status":"reference","sectionId":"section-1","rev":1,"updatedAt":at},
                {"id":"already-archived","title":"Already archived","status":"archived","sectionId":"section-1","archivedAt":"2026-08-01T00:00:00Z","rev":1,"updatedAt":at},
                {"id":"foreign","title":"Foreign","status":"next","projectId":"project-2","sectionId":"section-1","rev":1,"updatedAt":at},
                {"id":"other-section","title":"Other section","status":"next","sectionId":"section-2","rev":1,"updatedAt":at}
            ],
            "projects": [
                {"id":"project-1","title":"Project","status":"active","color":"#000","rev":1,"updatedAt":at},
                {"id":"project-2","title":"Other","status":"active","color":"#000","rev":1,"updatedAt":at}
            ],
            "sections": [
                {"id":"section-1","projectId":"project-1","title":"Section","rev":1,"updatedAt":at},
                {"id":"section-2","projectId":"project-2","title":"Other section","rev":1,"updatedAt":at}
            ],
            "areas": [], "people": [], "settings": {"deviceId":"device-a"}
        });
        let foreign_before = data["tasks"][5].clone();
        let other_before = data["tasks"][6].clone();
        let (_, archived_tasks, _) = patch_project_in_data(
            &mut data,
            "project-1",
            json!({"status":"archived"}).as_object().unwrap(),
        )
        .expect("archive project");
        assert_eq!(archived_tasks.len(), 5);
        let archived_at = data["projects"][0]["archivedAt"].clone();
        for task in data["tasks"].as_array().unwrap().iter().take(4) {
            assert_eq!(task["archivedAt"], archived_at);
        }
        for task in data["tasks"].as_array().unwrap().iter().take(5) {
            assert_eq!(task["projectId"], "project-1");
        }
        assert_eq!(data["tasks"][1]["status"], "done");
        assert_eq!(data["tasks"][2]["status"], "done");
        assert_eq!(data["tasks"][3]["status"], "reference");
        assert_eq!(data["tasks"][4]["archivedAt"], "2026-08-01T00:00:00Z");
        assert_eq!(data["tasks"][4]["updatedAt"], archived_at);
        assert_eq!(data["tasks"][4]["rev"], 2);
        assert_eq!(data["tasks"][5], foreign_before);
        assert_eq!(data["tasks"][6], other_before);

        let (_, restored_tasks, _) = patch_project_in_data(
            &mut data,
            "project-1",
            json!({"status":"active"}).as_object().unwrap(),
        )
        .expect("reactivate project");
        assert_eq!(restored_tasks.len(), 4);
        assert_eq!(data["tasks"][1]["status"], "next");
        assert_eq!(data["tasks"][2]["status"], "waiting");
        for task in data["tasks"].as_array().unwrap().iter().take(4) {
            assert!(task.get("archivedAt").is_none());
        }
        assert_eq!(data["tasks"][4]["archivedAt"], "2026-08-01T00:00:00Z");
        assert_eq!(data["tasks"][5], foreign_before);
        assert_eq!(data["tasks"][6], other_before);
    }

    #[test]
    fn local_api_reactivation_repairs_legacy_section_only_archived_child() {
        let at = "2026-09-01T00:00:00Z";
        let mut data = json!({
            "tasks": [
                {"id":"legacy","title":"Legacy","status":"archived","sectionId":"section-1","archivedAt":"2026-08-01T00:00:00Z","rev":1,"updatedAt":at},
                {"id":"foreign","title":"Foreign","status":"archived","projectId":"project-2","sectionId":"section-1","rev":1,"updatedAt":at},
                {"id":"deleted","title":"Deleted","status":"archived","sectionId":"section-1","deletedAt":at,"rev":1,"updatedAt":at}
            ],
            "projects": [{"id":"project-1","title":"Project","status":"archived","archivedAt":at,"color":"#000","rev":1,"updatedAt":at}],
            "sections": [{"id":"section-1","projectId":"project-1","title":"Section","rev":1,"updatedAt":at}],
            "areas": [], "people": [], "settings": {"deviceId":"device-a"}
        });
        let foreign_before = data["tasks"][1].clone();
        let deleted_before = data["tasks"][2].clone();
        let (_, changed_tasks, _) = patch_project_in_data(
            &mut data,
            "project-1",
            json!({"status":"active"}).as_object().unwrap(),
        )
        .expect("reactivate project");
        assert_eq!(changed_tasks.len(), 1);
        assert_eq!(data["tasks"][0]["projectId"], "project-1");
        assert_eq!(data["tasks"][0]["archivedAt"], "2026-08-01T00:00:00Z");
        assert_eq!(data["tasks"][0]["rev"], 2);
        assert_eq!(
            data["tasks"][0]["updatedAt"],
            data["projects"][0]["updatedAt"]
        );
        assert_eq!(data["tasks"][1], foreign_before);
        assert_eq!(data["tasks"][2], deleted_before);
    }

    #[test]
    fn local_api_task_triage_accepts_non_terminal_statuses_and_normalizes_reference() {
        for status in ["inbox", "next", "waiting", "someday"] {
            let mut task = json!({
                "id": "task-1", "title": "Triage", "status": "next",
                "isFocusedToday": true, "focusOrder": 4, "boardOrder": 9,
                "completedAt": "2026-01-01T00:00:00Z", "cancelledAt": "2026-01-02T00:00:00Z",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"
            })
            .as_object()
            .unwrap()
            .clone();

            apply_task_patch(
                &mut task,
                json!({ "status": status }).as_object().unwrap(),
                "device-a",
            )
            .unwrap_or_else(|error| panic!("{status}: {error}"));

            assert_eq!(task["status"], status);
            assert!(task.get("completedAt").is_none(), "{status}");
            assert!(task.get("cancelledAt").is_none(), "{status}");
            if status != "next" {
                assert!(task.get("boardOrder").is_none(), "{status}");
            }
            if status == "inbox" {
                assert_eq!(task["isFocusedToday"], false);
                assert!(task.get("focusOrder").is_none());
            }
        }

        let mut reference = json!({
            "id": "task-r", "title": "Reference", "status": "waiting",
            "startTime": "2026-10-01", "dueDate": "2026-10-02", "reviewAt": "2026-10-03",
            "relativeStartOffset": { "amount": -1, "unit": "day" },
            "recurrence": { "rule": "daily", "seriesId": "task-r" },
            "priority": "high", "timeEstimate": "15min", "suppressMindwtrReminders": true,
            "repeatReminderMinutes": 15, "showFutureRecurrence": true,
            "isFocusedToday": true, "focusOrder": 1, "boardOrder": 2, "pushCount": 3,
            "tags": [], "contexts": [], "rev": 1,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"
        })
        .as_object()
        .unwrap()
        .clone();
        apply_task_patch(
            &mut reference,
            json!({ "status": "reference" }).as_object().unwrap(),
            "device-a",
        )
        .expect("reference transition");
        assert_eq!(reference["status"], "reference");
        for field in [
            "startTime",
            "dueDate",
            "reviewAt",
            "relativeStartOffset",
            "recurrence",
            "priority",
            "timeEstimate",
            "suppressMindwtrReminders",
            "repeatReminderMinutes",
            "showFutureRecurrence",
            "focusOrder",
            "boardOrder",
        ] {
            assert!(
                reference.get(field).is_none(),
                "reference must clear {field}"
            );
        }
        assert_eq!(reference["isFocusedToday"], false);
        assert_eq!(reference["pushCount"], 0);
    }

    #[test]
    fn local_api_task_triage_rejects_source_conflicts_and_contradictory_cancellation() {
        for (label, extra) in [
            ("deleted", json!({ "deletedAt": "2026-09-01T00:00:00Z" })),
            ("purged", json!({ "purgedAt": "2026-09-01T00:00:00Z" })),
        ] {
            let mut task = json!({
                "id": "task-1", "title": "Triage", "status": "next",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"
            })
            .as_object()
            .unwrap()
            .clone();
            task.extend(extra.as_object().unwrap().clone());
            let original = task.clone();
            let error = apply_task_patch(
                &mut task,
                json!({ "status": "waiting" }).as_object().unwrap(),
                "device-a",
            )
            .expect_err(label);
            assert_eq!(api_error_response(error).status, 409, "{label}");
            assert_eq!(task, original, "{label}");
        }

        for source in ["done", "archived"] {
            let mut task = json!({
                "id": "task-1", "title": "Triage", "status": source,
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"
            })
            .as_object()
            .unwrap()
            .clone();
            let original = task.clone();
            let error = apply_task_patch(
                &mut task,
                json!({ "status": "next" }).as_object().unwrap(),
                "device-a",
            )
            .expect_err(source);
            assert_eq!(api_error_response(error).status, 409, "{source}");
            assert_eq!(task, original, "{source}");
        }

        let mut task = json!({
            "id": "task-1", "title": "Triage", "status": "next",
            "tags": [], "contexts": [], "rev": 1,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"
        })
        .as_object()
        .unwrap()
        .clone();
        let original = task.clone();
        let error = apply_task_patch(
            &mut task,
            json!({
                "status": "waiting",
                "cancelledAt": "2026-09-01T00:00:00Z"
            })
            .as_object()
            .unwrap(),
            "device-a",
        )
        .expect_err("contradictory lifecycle patch");
        assert_eq!(api_error_response(error).status, 400);
        assert_eq!(task, original);
    }

    #[test]
    fn local_api_task_triage_rejects_archived_project_owners_but_allows_move_out() {
        let archived_at = "2026-09-01T00:00:00Z";
        let base = json!({
            "tasks": [{
                "id": "task-1", "title": "Archived reference", "status": "reference",
                "projectId": "project-1", "sectionId": "section-1",
                "tags": [], "contexts": [], "rev": 1,
                "createdAt": archived_at, "updatedAt": archived_at
            }],
            "projects": [{
                "id": "project-1", "title": "Archived", "status": "archived",
                "color": "#000000", "order": 0, "tagIds": [], "isSequential": false,
                "rev": 2, "createdAt": archived_at, "updatedAt": archived_at
            }],
            "sections": [{
                "id": "section-1", "projectId": "project-1", "title": "Archived section",
                "order": 0, "deletedAt": archived_at, "projectArchivedAt": archived_at,
                "rev": 2, "createdAt": archived_at, "updatedAt": archived_at
            }],
            "areas": [], "people": [], "settings": { "deviceId": "device-a" }
        });

        let mut direct_owner = base.clone();
        let original = direct_owner.clone();
        let error = patch_task_in_data(
            &mut direct_owner,
            "task-1",
            json!({ "status": "next" }).as_object().unwrap(),
        )
        .expect_err("archived project must be reactivated first");
        assert_eq!(api_error_response(error).status, 409);
        assert_eq!(direct_owner, original, "rejection must be atomic");

        let mut hidden_section_owner = base.clone();
        hidden_section_owner["tasks"][0]
            .as_object_mut()
            .unwrap()
            .remove("projectId");
        let original = hidden_section_owner.clone();
        let error = patch_task_in_data(
            &mut hidden_section_owner,
            "task-1",
            json!({ "status": "waiting" }).as_object().unwrap(),
        )
        .expect_err("archived section ownership must also be rejected");
        assert_eq!(api_error_response(error).status, 409);
        assert_eq!(hidden_section_owner, original, "rejection must be atomic");

        let mut moved_out = base;
        let moved = patch_task_in_data(
            &mut moved_out,
            "task-1",
            json!({ "status": "next", "projectId": null })
                .as_object()
                .unwrap(),
        )
        .expect("moving out in the same patch is safe");
        assert_eq!(moved["status"], "next");
        assert!(moved.get("projectId").is_none());
        assert!(moved.get("sectionId").is_none());
        assert_eq!(moved_out["projects"][0]["status"], "archived");
        assert_eq!(moved_out["sections"][0]["deletedAt"], archived_at);
    }
}
