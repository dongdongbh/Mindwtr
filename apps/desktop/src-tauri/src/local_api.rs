use crate::storage::{
    ensure_data_file, load_data_snapshot, mutate_task_rows_with_retries, TaskMutationReadScope,
    TASK_MUTATION_FOCUSED_COUNT_KEY, TASK_MUTATION_PROJECT_NEXT_ORDERS_KEY,
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
use time::{Date, Month, OffsetDateTime};

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

struct LocalApiHandle {
    port: u16,
    shutdown: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
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

#[derive(Debug)]
struct ApiRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug)]
struct ApiResponse {
    status: u16,
    body: Value,
}

impl ApiResponse {
    fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }

    fn created(body: Value) -> Self {
        Self { status: 201, body }
    }

    fn error(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            body: json!({ "error": message.into() }),
        }
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn generate_uuid_v4() -> String {
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
    let Some(mut handle) = runtime.handle.take() else {
        return;
    };
    handle.shutdown.store(true, Ordering::SeqCst);
    let _ = TcpStream::connect((LOCAL_API_HOST, handle.port));
    if let Some(join) = handle.join.take() {
        let _ = join.join();
    }
}

fn start_runtime(
    app: tauri::AppHandle,
    port: u16,
    token: String,
    write_lock: Arc<Mutex<()>>,
) -> Result<LocalApiHandle, String> {
    ensure_data_file(&app)?;
    let listener = TcpListener::bind((LOCAL_API_HOST, port))
        .map_err(|error| format!("Failed to start local API server on port {port}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to configure local API server: {error}"))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = shutdown.clone();
    let active_connections = Arc::new(AtomicUsize::new(0));
    let join = thread::spawn(move || {
        while !thread_shutdown.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let Some(stream) = accept_or_reject(stream, &active_connections) else {
                        continue;
                    };
                    let app = app.clone();
                    let token = token.clone();
                    let write_lock = write_lock.clone();
                    let active_connections = active_connections.clone();
                    thread::spawn(move || {
                        let _slot_guard = ConnectionSlotGuard(active_connections);
                        handle_connection(app, token, write_lock, stream);
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(error) => {
                    log::warn!("Local API accept failed: {error}");
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

    let mut runtime = state
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
    let runtime = state.inner.lock().map_err(|e| e.to_string())?;
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
    let mut runtime = state.inner.lock().map_err(|e| e.to_string())?;

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
    app: tauri::AppHandle,
    token: String,
    write_lock: Arc<Mutex<()>>,
    mut stream: TcpStream,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let deadline = Instant::now() + REQUEST_DEADLINE;
    let response = match read_request(&mut stream, deadline) {
        Ok(Some(request)) => handle_api_request(&app, &token, &write_lock, request),
        Ok(None) => return,
        Err(error) => ApiResponse::error(400, error),
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
    let (path, query) = parse_request_target(target);

    let mut content_length = 0_usize;
    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let header_name = name.trim().to_ascii_lowercase();
        let header_value = value.trim().to_string();
        if header_name == "content-length" {
            content_length = value
                .trim()
                .parse::<usize>()
                .map_err(|_| "Invalid Content-Length".to_string())?;
        }
        headers.insert(header_name, header_value);
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
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let body = serde_json::to_string_pretty(&response.body).unwrap_or_else(|_| "{}".to_string());
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
    request: ApiRequest,
) -> ApiResponse {
    if request.method == "OPTIONS" {
        return ApiResponse::ok(json!({ "ok": true }));
    }
    if !is_request_authorized(&request, token) {
        return ApiResponse::error(401, "Unauthorized");
    }

    match route_api_request(app, write_lock, request) {
        Ok(response) => response,
        Err(error) => api_error_response(error),
    }
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

fn is_request_authorized(request: &ApiRequest, token: &str) -> bool {
    let expected_digest = Sha256::digest(format!("Bearer {token}").as_bytes());
    let actual_digest = request
        .headers
        .get("authorization")
        .map(|value| Sha256::digest(value.trim().as_bytes()));
    match actual_digest {
        Some(actual_digest) => constant_time_eq(&actual_digest, &expected_digest),
        None => false,
    }
}

fn api_error_response(error: String) -> ApiResponse {
    if error == "Task not found" {
        return ApiResponse::error(404, error);
    }
    if error.starts_with("Invalid ")
        || error.starts_with("Unsupported ")
        || error.starts_with("Task title")
        || error.starts_with("Request ")
    {
        return ApiResponse::error(400, error);
    }
    ApiResponse::error(500, error)
}

fn route_api_request(
    app: &tauri::AppHandle,
    write_lock: &Arc<Mutex<()>>,
    request: ApiRequest,
) -> Result<ApiResponse, String> {
    let segments = path_segments(&request.path);

    if request.method == "GET" && request.path == "/health" {
        return Ok(ApiResponse::ok(json!({ "ok": true })));
    }

    if request.method == "GET" && request.path == "/tasks" {
        let data = load_data_snapshot(app)?;
        let tasks = filter_tasks(array_items(&data, "tasks"), &request.query)?;
        return Ok(ApiResponse::ok(json!({ "tasks": tasks })));
    }

    if request.method == "GET" && request.path == "/projects" {
        let data = load_data_snapshot(app)?;
        let projects = array_items(&data, "projects")
            .into_iter()
            .filter(|project| !has_string_field(project, "deletedAt"))
            .collect::<Vec<_>>();
        return Ok(ApiResponse::ok(json!({ "projects": projects })));
    }

    if request.method == "GET" && (request.path == "/areas" || request.path == "/v1/areas") {
        let data = load_data_snapshot(app)?;
        let areas = array_items(&data, "areas")
            .into_iter()
            .filter(|area| !has_string_field(area, "deletedAt"))
            .collect::<Vec<_>>();
        return Ok(ApiResponse::ok(json!({ "areas": areas })));
    }

    if request.method == "GET" && request.path == "/search" {
        let data = load_data_snapshot(app)?;
        let query = request.query.get("query").cloned().unwrap_or_default();
        return Ok(ApiResponse::ok(search_data(&data, &query)));
    }

    if segments.len() == 2 && segments[0] == "tasks" && request.method == "GET" {
        let data = load_data_snapshot(app)?;
        let task = find_task(&data, &segments[1]).ok_or_else(|| "Task not found".to_string())?;
        return Ok(ApiResponse::ok(json!({ "task": task })));
    }

    if request.method == "POST" && request.path == "/tasks" {
        let _guard = write_lock.lock().map_err(|e| e.to_string())?;
        let body = parse_body_object(&request.body)?;
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
        let (task_id, persisted) = mutate_task_rows_with_retries(app, scope, |data| {
            let task = create_task_from_body(&body, &device_id_from_data(data), data)?;
            let task_id = task
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Task id is required".to_string())?
                .to_string();
            let task = Value::Object(task);
            ensure_array_mut(data, "tasks")?.push(task.clone());
            Ok((task_id, vec![task]))
        })?;
        return Ok(ApiResponse::created(
            json!({ "task": persisted_task(&persisted, &task_id)? }),
        ));
    }

    if segments.len() == 2 && segments[0] == "tasks" && request.method == "PATCH" {
        let _guard = write_lock.lock().map_err(|e| e.to_string())?;
        let body = parse_body_object(&request.body)?;
        let scope = TaskMutationReadScope::patch(
            &segments[1],
            body.get("projectId").and_then(Value::as_str),
            body.get("sectionId").and_then(Value::as_str),
            body.get("areaId").and_then(Value::as_str),
        );
        let (_, persisted) = mutate_task_rows_with_retries(app, scope, |data| {
            let task = patch_task_in_data(data, &segments[1], &body)?;
            Ok(((), vec![task]))
        })?;
        return Ok(ApiResponse::ok(
            json!({ "task": persisted_task(&persisted, &segments[1])? }),
        ));
    }

    if segments.len() == 2 && segments[0] == "tasks" && request.method == "DELETE" {
        let _guard = write_lock.lock().map_err(|e| e.to_string())?;
        let scope = TaskMutationReadScope::existing(&segments[1], false);
        mutate_task_rows_with_retries(app, scope, |data| {
            let device_id = device_id_from_data(data);
            let task = update_task_in_data(data, &segments[1], |task| {
                let now = now_iso();
                task.insert("deletedAt".to_string(), Value::String(now.clone()));
                task.insert("updatedAt".to_string(), Value::String(now));
                bump_task_revision(task, &device_id);
                Ok(())
            })?;
            Ok(((), vec![task]))
        })?;
        return Ok(ApiResponse::ok(json!({ "ok": true })));
    }

    if segments.len() == 3 && segments[0] == "tasks" && request.method == "POST" {
        let action = segments[2].as_str();
        if !matches!(action, "complete" | "archive" | "restore") {
            return Ok(ApiResponse::error(404, "Not found"));
        }
        let _guard = write_lock.lock().map_err(|e| e.to_string())?;
        let scope = TaskMutationReadScope::existing(&segments[1], action == "restore");
        let mutation = mutate_task_rows_with_retries(app, scope, |data| {
            if action == "complete" && recurrence_completion_refusal(data, &segments[1]).is_some() {
                return Err(RECURRENCE_REQUIRES_APP.to_string());
            }
            let device_id = device_id_from_data(data);
            let live_containers = if action == "restore" {
                LiveContainers::from_data(data)
            } else {
                LiveContainers::default()
            };
            let now = now_iso();
            let mut recurring_follow_up: Option<Map<String, Value>> = None;
            let task = update_task_in_data(data, &segments[1], |task| {
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
            Ok(((), changed_tasks))
        });
        let (_, persisted) = match mutation {
            Ok(result) => result,
            Err(error) if error == RECURRENCE_REQUIRES_APP => {
                return Ok(recurrence_completion_refusal_response());
            }
            Err(error) => return Err(error),
        };
        return Ok(ApiResponse::ok(
            json!({ "task": persisted_task(&persisted, &segments[1])? }),
        ));
    }

    Ok(ApiResponse::error(404, "Not found"))
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

/// Refuses `POST /tasks/{id}/complete` outright when the task's recurrence
/// carries selectors this engine cannot compute (byDay/byMonthDay/rrule —
/// see `recurrence_needs_core_engine`). A vanished recurring series is worse
/// than a rejected request: nothing is read here except to decide, and the
/// caller must not proceed to `update_task_in_data` when this returns `Some`,
/// so the task is left completely untouched on disk.
fn recurrence_completion_refusal(data: &Value, task_id: &str) -> Option<ApiResponse> {
    let task = find_task(data, task_id)?;
    let task_object = task.as_object()?;
    let previous_status = task_object
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("inbox");
    if !should_create_recurring_follow_up("complete", previous_status) {
        return None;
    }
    if recurrence_rule(task_object).is_none() || !recurrence_needs_core_engine(task_object) {
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
    section_project_ids: std::collections::HashMap<String, String>,
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
            section_project_ids,
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
    let section_project_id = candidate_section_id
        .as_ref()
        .and_then(|id| live.section_project_ids.get(id))
        .cloned();
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

pub(crate) fn patch_task_in_data(
    data: &mut Value,
    task_id: &str,
    patch: &Map<String, Value>,
) -> Result<Value, String> {
    let device_id = device_id_from_data(data);
    let live_containers = LiveContainers::from_data(data);
    update_task_in_data(data, task_id, |task| {
        apply_task_patch_with_containers(task, patch, &device_id, &live_containers)
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
            if !has_non_empty_string(task, "completedAt") {
                task.insert("completedAt".to_string(), Value::String(now.to_string()));
            }
            task.insert("isFocusedToday".to_string(), Value::Bool(false));
            task.remove("focusOrder");
            task.remove("boardOrder");
        }
        "restore" => {
            task.remove("deletedAt");
            task.remove("purgedAt");
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

fn create_next_recurring_task_for_local_api(
    task: &Map<String, Value>,
    completed_at: &str,
    previous_status: &str,
) -> Option<Map<String, Value>> {
    let rule = recurrence_rule(task)?;
    if recurrence_needs_core_engine(task) {
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

fn local_api_schedule_time(value: Option<&Value>) -> Option<OffsetDateTime> {
    let value = value?.as_str()?;
    if let Some(date) = parse_iso_date_bytes(value.as_bytes()) {
        return date.with_hms(0, 0, 0).ok().map(|value| value.assume_utc());
    }
    OffsetDateTime::parse(value, &Rfc3339).ok()
}

fn local_api_due_schedule_time(value: Option<&Value>) -> Option<OffsetDateTime> {
    let value = value?.as_str()?;
    if let Some(date) = parse_iso_date_bytes(value.as_bytes()) {
        return date
            .with_hms_milli(23, 59, 59, 999)
            .ok()
            .map(|value| value.assume_utc());
    }
    OffsetDateTime::parse(value, &Rfc3339).ok()
}

fn local_api_review_is_due(task: &Map<String, Value>, now: OffsetDateTime) -> bool {
    local_api_schedule_time(task.get("reviewAt")).is_some_and(|review| review <= now)
}

fn local_api_task_is_future_start(task: &Map<String, Value>, now: OffsetDateTime) -> bool {
    let defer_until = local_api_schedule_time(task.get("startTime")).or_else(|| {
        recurrence_rule(task).and_then(|_| {
            [
                local_api_schedule_time(task.get("dueDate")),
                local_api_schedule_time(task.get("reviewAt")),
            ]
            .into_iter()
            .flatten()
            .min()
        })
    });
    defer_until.is_some_and(|value| value.date() > now.date())
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

fn local_api_focused_task_count(data: &Value) -> usize {
    if let Some(count) = data
        .get(TASK_MUTATION_FOCUSED_COUNT_KEY)
        .and_then(Value::as_u64)
    {
        return count as usize;
    }
    array_items(data, "tasks")
        .iter()
        .filter(|task| {
            !has_string_field(task, "deletedAt")
                && task.get("isFocusedToday").and_then(Value::as_bool) == Some(true)
                && !matches!(
                    task.get("status").and_then(Value::as_str),
                    Some("done" | "reference")
                )
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

fn local_api_focus_schedule_key(task: &Map<String, Value>, now: OffsetDateTime) -> (u8, i128) {
    if task.get("isFocusedToday").and_then(Value::as_bool) == Some(true) {
        return (0, 0);
    }
    let mut scheduled = Vec::new();
    if let Some(due) = local_api_due_schedule_time(task.get("dueDate")) {
        if due.date() <= now.date() {
            scheduled.push(due.unix_timestamp_nanos());
        }
    }
    if let Some(start) = local_api_schedule_time(task.get("startTime")) {
        if start.date() == now.date() {
            scheduled.push(start.unix_timestamp_nanos());
        }
    }
    if local_api_review_is_due(task, now) {
        if let Some(review) = local_api_schedule_time(task.get("reviewAt")) {
            scheduled.push(review.unix_timestamp_nanos());
        }
    }
    scheduled
        .into_iter()
        .min()
        .map(|time| (1, time))
        .unwrap_or((2, i128::MAX))
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
    local_api_schedule_time(task.get("createdAt"))
        .map(|value| value.unix_timestamp_nanos() as f64)
        .unwrap_or(f64::INFINITY)
}

fn local_api_focus_candidate_is_sequential_first(
    candidate: &Map<String, Value>,
    data: &Value,
    now: OffsetDateTime,
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
                || task.get("projectId").and_then(Value::as_str) != Some(project_id)
                || (section_scoped
                    && task.get("sectionId").and_then(Value::as_str) != candidate_section)
                || !matches!(
                    task.get("status").and_then(Value::as_str),
                    Some("inbox" | "next" | "waiting" | "someday")
                )
                || !(task.get("isFocusedToday").and_then(Value::as_bool) == Some(true)
                    || task.get("status").and_then(Value::as_str) == Some("next")
                    || local_api_review_is_due(&task, now))
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
    let mut best_schedule = (u8::MAX, i128::MAX);
    let mut best_order = f64::INFINITY;
    for task in &candidates {
        let schedule = local_api_focus_schedule_key(task, now);
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

fn normalize_created_task_focus(task: &mut Map<String, Value>, data: &Value, now: &str) {
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
    let status_is_eligible = promoted_status == "next"
        || (promoted_status != "inbox" && local_api_review_is_due(&candidate, now));
    let eligible = status_is_eligible
        && local_api_project_allows_focus(&candidate, data)
        && !local_api_task_is_future_start(&candidate, now)
        && local_api_focus_candidate_is_sequential_first(&candidate, data, now);
    let cap_is_available = local_api_focused_task_count(data) < local_api_focus_task_limit(data);
    if eligible && cap_is_available {
        task.insert(
            "status".to_string(),
            Value::String(promoted_status.to_string()),
        );
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
    if task.get("status").and_then(Value::as_str) == Some("reference") {
        normalize_created_reference_task(&mut task);
    }
    normalize_created_task_focus(&mut task, data, &now);
    task.insert("rev".to_string(), Value::Number(1.into()));
    task.insert("revBy".to_string(), Value::String(device_id.to_string()));
    Ok(task)
}

pub(crate) fn apply_task_patch(
    task: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    device_id: &str,
) -> Result<(), String> {
    apply_task_patch_internal(task, patch, device_id, None)
}

fn apply_task_patch_with_containers(
    task: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    device_id: &str,
    live_containers: &LiveContainers,
) -> Result<(), String> {
    apply_task_patch_internal(task, patch, device_id, Some(live_containers))
}

fn apply_task_patch_internal(
    task: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    device_id: &str,
    live_containers: Option<&LiveContainers>,
) -> Result<(), String> {
    if patch.contains_key("status") {
        return Err(
            "Invalid task field: status; use the complete, archive, or restore action".to_string(),
        );
    }
    let mut sanitized = patch.clone();
    sanitize_task_patch_map(&mut sanitized)?;
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
    for (key, value) in sanitized {
        if value.is_null() {
            task.remove(&key);
        } else {
            task.insert(key, value);
        }
    }
    task.insert("updatedAt".to_string(), Value::String(now_iso()));
    bump_task_revision(task, device_id);
    Ok(())
}

fn sanitize_task_patch_map(patch: &mut Map<String, Value>) -> Result<(), String> {
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
            _ => return Err(format!("Unsupported task field: {key}")),
        };
        if !valid {
            return Err(format!("Invalid task field: {key}"));
        }
    }
    Ok(())
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

fn valid_iso_date_like(value: &str) -> bool {
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
                    .all(|item| item.as_i64().is_some_and(|day| (1..=31).contains(&day) || day == -1))
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
                "mimeType" | "deletedAt" | "fileHash" => value.is_string(),
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

fn percent_decode(raw: &str) -> Option<String> {
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
        }]);
        assert!(valid_attachments(&round_trip));

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
        }]);
        let duplicated =
            duplicate_attachment_value(Some(&original), "2026-01-02T00:00:00.000Z")
                .expect("duplicated attachments");
        let copy = duplicated[0].as_object().expect("attachment object");
        assert_eq!(copy.get("uri"), Some(&json!("file:///report.pdf")));
        assert!(!copy.contains_key("cloudKey"));
        assert!(!copy.contains_key("fileHash"));
        assert!(!copy.contains_key("localStatus"));
        assert!(!copy.contains_key("contentRev"));
        assert!(!copy.contains_key("contentMtimeMs"));
        assert!(!copy.contains_key("contentSize"));
    }

    #[test]
    fn local_api_patch_rejects_generic_status_transitions() {
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
        .expect_err("status changes require lifecycle actions");

        assert!(error.contains("complete, archive, or restore"));
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
    fn local_api_create_rejects_ineligible_focus_without_reclassifying() {
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
            &empty_local_api_data(),
        )
        .expect("future task");
        assert_eq!(future["status"], "inbox");
        assert_eq!(future["isFocusedToday"], false);

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
            // The same fixture file also carries `kind: "action"` cases
            // (complete/archive/restore write-path parity), asserted by
            // `local_api_apply_task_action_matches_core_write_path_fixture`
            // instead - this test only owns the recurrence-only cases, which
            // predate the `kind` field, so its absence means "recurrence".
            if test_case.get("kind").and_then(Value::as_str) == Some("action") {
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
        assert!(recurrence_completion_refusal(&data, "byday-archived").is_none());
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
                let refusal = recurrence_completion_refusal(&data, &task_id)
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
}
