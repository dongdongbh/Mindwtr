//! Opt-in in-process MCP. REST and MCP invoke the same native operations.
use crate::config::read_config_verified;
use crate::local_api::{
    self, ApiRequest, ApiResponse, LocalApiAccess, LocalApiHandle, LocalApiServerState,
    LocalOperation,
};
use crate::{
    get_config_path, get_secrets_path, lock_config_read_modify_write, write_config_files,
    AppConfigToml,
};
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const MCP_PORT: u16 = 8722;
const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[PROTOCOL_VERSION];

#[derive(Clone, PartialEq, Eq)]
struct McpConfig {
    enabled: bool,
    allow_write: bool,
    allow_archive: bool,
    allow_delete: bool,
    port: u16,
    token: Option<String>,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            allow_write: false,
            allow_archive: false,
            allow_delete: false,
            port: MCP_PORT,
            token: None,
        }
    }
}

impl McpConfig {
    fn permissions(&self) -> McpPermissions {
        McpPermissions {
            allow_write: self.allow_write,
            allow_archive: self.allow_archive,
            allow_delete: self.allow_delete,
        }
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct McpPermissions {
    pub(crate) allow_write: bool,
    pub(crate) allow_archive: bool,
    pub(crate) allow_delete: bool,
}

impl McpPermissions {
    pub(crate) fn any_write(self) -> bool {
        self.allow_write || self.allow_archive || self.allow_delete
    }

    fn denied_category(self, operation: &LocalOperation) -> Option<&'static str> {
        let archives = |body: &Map<String, Value>| {
            body.get("status").and_then(Value::as_str) == Some("archived")
                || body.get("cancelledAt").is_some_and(Value::is_string)
        };
        let (edit, archive, delete) = match operation {
            LocalOperation::DeleteTask(_)
            | LocalOperation::ProjectLifecycle { restore: false, .. } => (false, false, true),
            LocalOperation::TaskAction { action, .. } if action == "archive" => {
                (false, true, false)
            }
            LocalOperation::CreateTask(body) | LocalOperation::CreateProject(body) => (
                true,
                body.get("props")
                    .and_then(Value::as_object)
                    .is_some_and(archives),
                false,
            ),
            LocalOperation::PatchTask { body, .. } | LocalOperation::PatchProject { body, .. } => {
                let archive = archives(body);
                let edit = !archive
                    || body
                        .keys()
                        .any(|field| !matches!(field.as_str(), "status" | "cancelledAt"));
                (edit, archive, false)
            }
            _ => (operation.writes(), false, false),
        };
        if edit && !self.allow_write {
            Some("edit")
        } else if archive && !self.allow_archive {
            Some("archive")
        } else if delete && !self.allow_delete {
            Some("delete")
        } else {
            None
        }
    }
}

#[derive(Clone, Copy)]
struct McpConfigRequest {
    enabled: bool,
    allow_write: bool,
    allow_archive: Option<bool>,
    allow_delete: Option<bool>,
    port: Option<f64>,
    regenerate_token: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum McpError {
    PortInUse,
    StartFailed,
    Exited,
    ConfigFailed,
    InvalidPort,
}

impl McpError {
    fn code(self) -> &'static str {
        match self {
            Self::PortInUse => "port_in_use",
            Self::StartFailed => "start_failed",
            Self::Exited => "exited",
            Self::ConfigFailed => "config_failed",
            Self::InvalidPort => "invalid_port",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerStatus {
    enabled: bool,
    running: bool,
    allow_write: bool,
    allow_archive: bool,
    allow_delete: bool,
    port: u16,
    url: Option<String>,
    token: Option<String>,
    error: Option<String>,
}

fn lock_recovering<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn normalize_port(port: f64) -> Result<u16, McpError> {
    if !port.is_finite() || port.fract() != 0.0 || !(1024.0..=u16::MAX as f64).contains(&port) {
        return Err(McpError::InvalidPort);
    }
    Ok(port as u16)
}

fn config_from_toml(config: &AppConfigToml) -> Result<McpConfig, McpError> {
    let enabled =
        |value: Option<&String>| value.is_some_and(|raw| raw.trim().eq_ignore_ascii_case("true"));
    let allow_write = enabled(config.mcp_allow_write.as_ref());
    Ok(McpConfig {
        enabled: enabled(config.mcp_enabled.as_ref()),
        allow_write,
        allow_archive: enabled(config.mcp_allow_archive.as_ref()),
        // Old Allow changes granted deletion; preserve that existing grant.
        allow_delete: config
            .mcp_allow_delete
            .as_ref()
            .map_or(allow_write, |value| enabled(Some(value))),
        port: match config.mcp_port.as_ref() {
            Some(value) => {
                normalize_port(value.trim().parse().map_err(|_| McpError::InvalidPort)?)?
            }
            None => MCP_PORT,
        },
        token: config
            .mcp_token
            .as_ref()
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty()),
    })
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn apply_config(config: &mut AppConfigToml, next: &McpConfig) {
    config.mcp_enabled = Some(next.enabled.to_string());
    config.mcp_allow_write = Some(next.allow_write.to_string());
    config.mcp_allow_archive = Some(next.allow_archive.to_string());
    config.mcp_allow_delete = Some(next.allow_delete.to_string());
    config.mcp_port = Some(next.port.to_string());
    config.mcp_token = next.token.clone();
}

fn read_mcp_config(app: &tauri::AppHandle) -> Result<McpConfig, McpError> {
    // read_config can migrate legacy secrets and publish a repaired pair.
    // Protect that possible write from concurrent settings transactions too.
    let _guard = lock_config_read_modify_write().map_err(|_| McpError::ConfigFailed)?;
    read_config_verified(app)
        .map_err(|_| McpError::ConfigFailed)
        .and_then(|config| config_from_toml(&config))
}

/// The outer RMW lock remains held across read, token creation, and publication;
/// unrelated Local API/sync/settings fields cannot be overwritten by a stale
/// snapshot. Persistence always precedes starting a new listener.
fn update_config(
    app: &tauri::AppHandle,
    requested: Option<McpConfigRequest>,
) -> Result<McpConfig, McpError> {
    let _guard = lock_config_read_modify_write().map_err(|_| McpError::ConfigFailed)?;
    update_config_with(
        || read_config_verified(app),
        requested,
        |config| write_config_files(&get_config_path(app), &get_secrets_path(app), config),
    )
}

fn update_config_with(
    read: impl FnOnce() -> Result<AppConfigToml, String>,
    requested: Option<McpConfigRequest>,
    write: impl FnOnce(&AppConfigToml) -> Result<(), String>,
) -> Result<McpConfig, McpError> {
    let mut stored = read().map_err(|_| McpError::ConfigFailed)?;
    // A valid explicit port can repair malformed stored configuration.
    if let Some(port) = requested.and_then(|request| request.port) {
        stored.mcp_port = Some(normalize_port(port)?.to_string());
    }
    let original = config_from_toml(&stored)?;
    let mut next = original.clone();
    if let Some(requested) = requested {
        next.enabled = requested.enabled;
        next.allow_write = requested.allow_write;
        if let Some(value) = requested.allow_archive {
            next.allow_archive = value;
        }
        if let Some(value) = requested.allow_delete {
            next.allow_delete = value;
        }
        if let Some(port) = requested.port {
            next.port = normalize_port(port)?;
        }
        if requested.regenerate_token {
            next.token = Some(generate_token());
        }
    }
    if next.enabled && next.token.is_none() {
        next.token = Some(generate_token());
    }
    if requested.is_some() || next != original {
        apply_config(&mut stored, &next);
        write(&stored).map_err(|_| McpError::ConfigFailed)?;
    }
    Ok(next)
}

#[derive(Default)]
struct McpRuntime {
    listener: Option<LocalApiHandle>,
    applied_config: Option<McpConfig>,
    last_error: Option<McpError>,
}

impl McpRuntime {
    fn stop(&mut self) {
        self.listener.take();
        self.applied_config.take();
    }

    fn refresh(&mut self) {
        if self
            .listener
            .as_ref()
            .is_some_and(|listener| !listener.is_running())
        {
            self.stop();
            self.last_error = Some(McpError::Exited);
        }
    }

    fn status_after_read(&mut self, config: Result<McpConfig, McpError>) -> McpServerStatus {
        self.refresh();
        match config {
            Err(error) => {
                self.stop();
                self.last_error = Some(error);
                self.status(McpConfig::default())
            }
            Ok(config) => {
                if self.listener.is_some() && self.applied_config.as_ref() != Some(&config) {
                    self.stop();
                    self.last_error = config.enabled.then_some(McpError::Exited);
                }
                self.status(config)
            }
        }
    }

    fn reconcile(
        &mut self,
        app: &tauri::AppHandle,
        local_api: &LocalApiServerState,
        config: &McpConfig,
        shutdown: &AtomicBool,
    ) {
        self.reconcile_with(config, |config| {
            if shutdown.load(Ordering::SeqCst) {
                return Err(McpError::StartFailed);
            }
            let token = config.token.clone().ok_or(McpError::ConfigFailed)?;
            local_api::start_mcp_listener(
                app.clone(),
                local_api,
                config.port,
                token,
                config.permissions(),
            )
            .map_err(|error| {
                if error == "port_in_use" {
                    McpError::PortInUse
                } else {
                    McpError::StartFailed
                }
            })
        });
    }

    fn reconcile_with(
        &mut self,
        config: &McpConfig,
        start: impl FnOnce(&McpConfig) -> Result<LocalApiHandle, McpError>,
    ) {
        self.refresh();
        if !config.enabled {
            self.stop();
            self.last_error = None;
        } else if self.listener.is_none() || self.applied_config.as_ref() != Some(config) {
            self.stop();
            match start(config) {
                Ok(listener) => {
                    self.listener = Some(listener);
                    self.applied_config = Some(config.clone());
                    self.last_error = None;
                    log::info!(
                        "In-process MCP listener ready extra.releaseCheck=v1.3.5/in-process-mcp"
                    );
                    log::info!("MCP access controls applied extra.releaseCheck=v1.3.7/mcp-access-controls allowWrite={} allowArchive={} allowDelete={} port={}", config.allow_write, config.allow_archive, config.allow_delete, config.port);
                }
                Err(error) => {
                    self.last_error = Some(error);
                    log::warn!("In-process MCP startup failed code={}", error.code());
                }
            }
        }
    }

    fn status(&self, config: McpConfig) -> McpServerStatus {
        McpServerStatus {
            enabled: config.enabled,
            running: self.listener.is_some(),
            allow_write: config.allow_write,
            allow_archive: config.allow_archive,
            allow_delete: config.allow_delete,
            port: self
                .listener
                .as_ref()
                .map_or(config.port, |listener| listener.port),
            url: self
                .listener
                .as_ref()
                .map(|listener| format!("http://127.0.0.1:{}/mcp", listener.port)),
            token: config.enabled.then_some(config.token).flatten(),
            error: self.last_error.map(|error| error.code().to_string()),
        }
    }
}

#[derive(Default)]
pub(crate) struct McpServerState {
    inner: Mutex<McpRuntime>,
    shutting_down: AtomicBool,
}

pub(crate) fn start_configured_mcp_server(
    app: &tauri::AppHandle,
    state: &McpServerState,
    local_api: &LocalApiServerState,
) {
    let mut runtime = lock_recovering(&state.inner);
    if state.shutting_down.load(Ordering::SeqCst) {
        return;
    }
    match update_config(app, None) {
        Ok(config) => runtime.reconcile(app, local_api, &config, &state.shutting_down),
        Err(error) => {
            runtime.stop();
            runtime.last_error = Some(error);
            log::warn!("In-process MCP configuration failed code={}", error.code());
        }
    }
}

pub(crate) fn stop_mcp_server(state: &McpServerState) {
    state.shutting_down.store(true, Ordering::SeqCst);
    lock_recovering(&state.inner).stop();
}

#[tauri::command(async)]
pub(crate) fn get_mcp_server_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, McpServerState>,
) -> Result<McpServerStatus, String> {
    Ok(lock_recovering(&state.inner).status_after_read(read_mcp_config(&app)))
}

#[tauri::command(async)]
pub(crate) fn set_mcp_server_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, McpServerState>,
    local_api: tauri::State<'_, LocalApiServerState>,
    enabled: bool,
    allow_write: bool,
    allow_archive: Option<bool>,
    allow_delete: Option<bool>,
    port: Option<f64>,
    regenerate_token: Option<bool>,
) -> Result<McpServerStatus, String> {
    if let Some(port) = port {
        normalize_port(port).map_err(|error| error.code().to_string())?;
    }
    let mut runtime = lock_recovering(&state.inner);
    if state.shutting_down.load(Ordering::SeqCst) {
        runtime.stop();
        return Ok(runtime.status(read_mcp_config(&app).unwrap_or_default()));
    }
    match update_config(
        &app,
        Some(McpConfigRequest {
            enabled,
            allow_write,
            allow_archive,
            allow_delete,
            port,
            regenerate_token: regenerate_token.unwrap_or(false),
        }),
    ) {
        Ok(config) => {
            runtime.reconcile(&app, &local_api, &config, &state.shutting_down);
            Ok(runtime.status(config))
        }
        Err(error) => {
            runtime.stop();
            runtime.last_error = Some(error);
            Ok(runtime.status(read_mcp_config(&app).unwrap_or_default()))
        }
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> ApiResponse {
    ApiResponse::ok(json!({"jsonrpc":"2.0", "id": id, "error": {"code": code, "message": message}}))
}

fn empty_params(params: &Map<String, Value>) -> bool {
    params.keys().all(|name| name == "_meta")
}

fn accepts(request: &ApiRequest, media_type: &str) -> bool {
    request.headers.get("accept").is_some_and(|header| {
        header.split(',').any(|part| {
            let mut parts = part.trim().split(';');
            parts
                .next()
                .is_some_and(|name| name.trim().eq_ignore_ascii_case(media_type))
                && !parts.any(|param| {
                    param
                        .trim()
                        .strip_prefix("q=")
                        .is_some_and(|q| q.parse::<f64>().is_ok_and(|q| q <= 0.0))
                })
        })
    })
}

pub(crate) fn handle_mcp_request(
    token: &str,
    access: &LocalApiAccess,
    permissions: McpPermissions,
    port: u16,
    request: ApiRequest,
    mut execute: impl FnMut(LocalOperation) -> Result<Value, String>,
) -> ApiResponse {
    if request.headers.get("host").map(String::as_str) != Some(format!("127.0.0.1:{port}").as_str())
    {
        return ApiResponse::error(403, "Invalid Host");
    }
    if request
        .headers
        .get("origin")
        .is_some_and(|origin| origin != &format!("http://127.0.0.1:{port}"))
    {
        return ApiResponse::error(403, "Invalid Origin");
    }
    if access.ensure_active().is_err() {
        return ApiResponse::error(403, "MCP server is stopped");
    }
    if !local_api::is_request_authorized(&request, token) {
        return ApiResponse::error(401, "Unauthorized");
    }
    if request.path != "/mcp" || !request.query.is_empty() {
        return ApiResponse::error(404, "Not found");
    }
    if request
        .headers
        .get("mcp-protocol-version")
        .is_some_and(|version| !SUPPORTED_PROTOCOL_VERSIONS.contains(&version.as_str()))
    {
        return ApiResponse::error(400, "Unsupported MCP protocol version");
    }
    if request.method != "POST" {
        return ApiResponse::error(405, "Method not allowed");
    }
    if !request.headers.get("content-type").is_some_and(|header| {
        header
            .split(';')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    }) {
        return ApiResponse::error(415, "Expected application/json");
    }
    if !accepts(&request, "application/json") || !accepts(&request, "text/event-stream") {
        return ApiResponse::error(
            406,
            "Accept must include application/json and text/event-stream",
        );
    }
    let message: Value = match serde_json::from_slice(&request.body) {
        Ok(message) => message,
        Err(_) => return rpc_error(Value::Null, -32700, "Parse error"),
    };
    let Some(message) = message.as_object() else {
        return rpc_error(Value::Null, -32600, "Invalid request");
    };
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || message
            .keys()
            .any(|name| !matches!(name.as_str(), "jsonrpc" | "id" | "method" | "params"))
        || message
            .get("id")
            .is_some_and(|id| !id.is_string() && id.as_i64().is_none() && id.as_u64().is_none())
    {
        return rpc_error(Value::Null, -32600, "Invalid request");
    }
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return rpc_error(id, -32600, "Invalid request");
    };
    let empty = Map::new();
    let params = match message.get("params") {
        None => &empty,
        Some(Value::Object(params)) => params,
        _ => return rpc_error(id, -32602, "Invalid params"),
    };
    if params.get("_meta").is_some_and(|meta| !meta.is_object()) {
        return rpc_error(id, -32602, "Invalid params");
    }
    if !message.contains_key("id") {
        if method == "notifications/initialized" && empty_params(params) {
            return ApiResponse {
                status: 202,
                body: Value::Null,
            };
        }
        return ApiResponse::error(400, "Unsupported notification");
    }
    let result = match method {
        "initialize" => {
            if params.keys().any(|name| {
                !matches!(
                    name.as_str(),
                    "protocolVersion" | "capabilities" | "clientInfo" | "_meta"
                )
            }) || params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
                || !params.get("capabilities").is_some_and(Value::is_object)
                || !params
                    .get("clientInfo")
                    .and_then(Value::as_object)
                    .is_some_and(|info| {
                        info.get("name")
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.is_empty())
                            && info
                                .get("version")
                                .and_then(Value::as_str)
                                .is_some_and(|s| !s.is_empty())
                    })
            {
                return rpc_error(id, -32602, "Invalid initialize params");
            }
            let requested = params["protocolVersion"].as_str().unwrap();
            json!({"protocolVersion": if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) { requested } else { PROTOCOL_VERSION },
                "capabilities": {"tools": {}}, "serverInfo": {"name":"mindwtr-mcp", "version": env!("CARGO_PKG_VERSION")}})
        }
        "ping" if empty_params(params) => json!({}),
        "tools/list" if empty_params(params) => json!({"tools": crate::mcp_tools::tools()}),
        "tools/call" => {
            if params
                .keys()
                .any(|name| !matches!(name.as_str(), "name" | "arguments" | "_meta"))
            {
                return rpc_error(id, -32602, "Invalid tools/call params");
            }
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return rpc_error(id, -32602, "Invalid tool name");
            };
            let arguments = match params.get("arguments") {
                None => &empty,
                Some(Value::Object(args)) => args,
                _ => return rpc_error(id, -32602, "Invalid tool arguments"),
            };
            let operation = match crate::mcp_tools::operation(name, arguments) {
                Ok(operation) => operation,
                Err(_) => return rpc_error(id, -32602, "Invalid or unsupported tool arguments"),
            };
            let writing = operation.writes();
            if let Some(category) = permissions.denied_category(&operation) {
                log::info!("MCP operation denied extra.releaseCheck=v1.3.7/mcp-access-controls category={category}");
                let (code, message) = match category {
                    "archive" => ("archive_not_allowed", "MCP archiving is disabled. Enable archiving in desktop settings."),
                    "delete" => ("delete_not_allowed", "MCP deletion is disabled. Enable deletion in desktop settings."),
                    _ => ("read_only", "MCP edits are disabled. Enable task and project edits in desktop settings."),
                };
                crate::mcp_tools::error_response(code, message)
            } else if writing && access.ensure_write().is_err() {
                crate::mcp_tools::error_response(
                    "read_only",
                    "MCP is read-only. Enable writes in desktop settings to edit.",
                )
            } else {
                match execute(operation) {
                    Ok(body) => {
                        let operation = if writing { "write" } else { "read" };
                        log::info!("In-process MCP native operation completed extra.releaseCheck=v1.3.5/in-process-mcp operation={operation}");
                        match crate::mcp_tools::tool_result(name, arguments, body) {
                            Ok(body) => {
                                json!({"content":[{"type":"text", "text": serde_json::to_string_pretty(&body).unwrap()}]})
                            }
                            Err(()) => {
                                crate::mcp_tools::error_response("not_found", "Entity not found.")
                            }
                        }
                    }
                    Err(error) => {
                        let response = local_api::api_error_response(error);
                        let error_message = response.body["error"].as_str().unwrap_or("");
                        let (code, message) = match response.status {
                            403 => ("read_only", "MCP access was revoked."),
                            404 => ("not_found", "Entity not found."),
                            409 if error_message.starts_with("Focus limit of ") => {
                                ("validation_error", error_message)
                            }
                            400 | 409 => ("validation_error", "Invalid input or lifecycle conflict. Check the item in the desktop app."),
                            _ => ("internal_error", "Native operation failed. For writes, check the desktop app before retrying."),
                        };
                        crate::mcp_tools::error_response(code, message)
                    }
                }
            }
        }
        "ping" | "tools/list" => return rpc_error(id, -32602, "Invalid params"),
        _ => return rpc_error(id, -32601, "Method not found"),
    };
    ApiResponse::ok(json!({"jsonrpc":"2.0", "id":id, "result":result}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn permissions(allowed: bool) -> McpPermissions {
        McpPermissions {
            allow_write: allowed,
            allow_archive: allowed,
            allow_delete: allowed,
        }
    }
    fn config_request(
        enabled: bool,
        allow_write: bool,
        regenerate_token: bool,
    ) -> McpConfigRequest {
        McpConfigRequest {
            enabled,
            allow_write,
            allow_archive: None,
            allow_delete: None,
            port: None,
            regenerate_token,
        }
    }
    fn access(allow_write: bool) -> LocalApiAccess {
        LocalApiAccess {
            allow_write,
            shutdown: Arc::new(AtomicBool::new(false)),
        }
    }
    fn request(message: Value) -> ApiRequest {
        ApiRequest {
            method: "POST".into(),
            path: "/mcp".into(),
            query: HashMap::new(),
            headers: HashMap::from([
                ("host".into(), "127.0.0.1:8722".into()),
                ("authorization".into(), "Bearer fixture-token".into()),
                ("content-type".into(), "application/json".into()),
                (
                    "accept".into(),
                    "application/json, text/event-stream".into(),
                ),
            ]),
            body: serde_json::to_vec(&message).unwrap(),
        }
    }
    fn call(method: &str, params: Value, allow_write: bool) -> ApiResponse {
        handle_mcp_request(
            "fixture-token",
            &access(allow_write),
            permissions(allow_write),
            MCP_PORT,
            request(json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})),
            |_| Ok(json!({"tasks":[]})),
        )
    }
    #[test]
    fn mcp_protocol_negotiation_notifications_and_bounded_scope() {
        for proposed in ["2025-03-26", "2025-06-18", "2099-01-01"] {
            let response = call(
                "initialize",
                json!({"protocolVersion":proposed,"capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}),
                false,
            );
            assert_eq!(
                response.body["result"]["protocolVersion"],
                if SUPPORTED_PROTOCOL_VERSIONS.contains(&proposed) {
                    proposed
                } else {
                    PROTOCOL_VERSION
                }
            );
        }
        assert_eq!(call("ping", json!({}), false).body["result"], json!({}));
        assert_eq!(
            call("tools/list", json!({}), false).body["result"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            14
        );
        assert_eq!(
            call("tools/list", json!({"cursor":"bogus"}), false).body["error"]["code"],
            -32602
        );
        assert_eq!(
            call("initialize", json!({"protocolVersion":"2025-06-18"}), false).body["error"]
                ["code"],
            -32602
        );
        let notification = handle_mcp_request(
            "fixture-token",
            &access(false),
            permissions(false),
            MCP_PORT,
            request(json!({"jsonrpc":"2.0","method":"notifications/initialized"})),
            |_| panic!(),
        );
        assert_eq!(notification.status, 202);
        assert!(notification.body.is_null());
        for invalid in [
            json!([]),
            json!({"jsonrpc":"1.0","method":"ping","id":1}),
            json!({"jsonrpc":"2.0","method":"ping","id":null}),
            json!({"jsonrpc":"2.0","method":"ping","id":1.5}),
        ] {
            assert_eq!(
                handle_mcp_request(
                    "fixture-token",
                    &access(false),
                    permissions(false),
                    MCP_PORT,
                    request(invalid),
                    |_| panic!()
                )
                .body["error"]["code"],
                -32600
            );
        }
    }
    #[test]
    fn mcp_http_security_and_negotiated_headers_are_checked_before_operations() {
        for (field, value, status) in [
            ("authorization", "Bearer bad", 401),
            ("host", "attacker.example:8722", 403),
            ("origin", "https://attacker.example", 403),
            ("content-type", "text/plain", 415),
            ("accept", "application/json", 406),
            ("accept", "application/json;q=0, text/event-stream", 406),
            ("mcp-protocol-version", "2099-01-01", 400),
            ("mcp-protocol-version", "2025-03-26", 400),
        ] {
            let mut request = request(json!({"jsonrpc":"2.0","id":1,"method":"ping"}));
            request.headers.insert(field.into(), value.into());
            assert_eq!(
                handle_mcp_request(
                    "fixture-token",
                    &access(false),
                    permissions(false),
                    MCP_PORT,
                    request,
                    |_| panic!()
                )
                .status,
                status,
                "{field}"
            );
        }
        for method in ["GET", "DELETE", "OPTIONS"] {
            let mut request = request(json!({"jsonrpc":"2.0","id":1,"method":"ping"}));
            request.method = method.into();
            assert_eq!(
                handle_mcp_request(
                    "fixture-token",
                    &access(false),
                    permissions(false),
                    MCP_PORT,
                    request,
                    |_| panic!()
                )
                .status,
                405
            );
        }
        let disabled = access(true);
        disabled.shutdown.store(true, Ordering::SeqCst);
        assert_eq!(
            handle_mcp_request(
                "fixture-token",
                &disabled,
                permissions(true),
                MCP_PORT,
                request(json!({"jsonrpc":"2.0","id":1,"method":"ping"})),
                |_| panic!()
            )
            .status,
            403
        );
    }
    #[test]
    fn mcp_read_only_and_argument_allowlists_block_native_execution() {
        for (name, arguments) in [
            ("mindwtr_add_task", json!({"title":"Task"})),
            ("mindwtr_update_task", json!({"id":"task","title":"Task"})),
            ("mindwtr_complete_task", json!({"id":"task"})),
            ("mindwtr_archive_task", json!({"id":"task"})),
            ("mindwtr_delete_task", json!({"id":"task"})),
            ("mindwtr_restore_task", json!({"id":"task"})),
            ("mindwtr_add_project", json!({"title":"Project"})),
            (
                "mindwtr_update_project",
                json!({"id":"project","title":"Project"}),
            ),
            ("mindwtr_delete_project", json!({"id":"project"})),
        ] {
            let response = handle_mcp_request(
                "fixture-token",
                &access(false),
                permissions(false),
                MCP_PORT,
                request(
                    json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":arguments}}),
                ),
                |_| panic!("read-only must not execute"),
            );
            assert_eq!(response.body["result"]["isError"], true, "{name}");
            assert!(response.body["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("disabled"));
        }
        for (name, args) in [
            ("mindwtr_get_task", json!({"id":1})),
            (
                "mindwtr_add_task",
                json!({"title":"Task","quickAdd":"ignored"}),
            ),
            ("mindwtr_update_task", json!({"id":"task","attachments":[]})),
            ("mindwtr_update_task", json!({"id":"task","status":"done"})),
            (
                "mindwtr_add_project",
                json!({"title":"P","supportNotes":"unsupported"}),
            ),
            ("mindwtr_list_tasks", json!({"view":"available"})),
            ("mindwtr_list_tasks", json!({"limit":"10"})),
        ] {
            assert_eq!(
                call("tools/call", json!({"name":name,"arguments":args}), true).body["error"]
                    ["code"],
                -32602,
                "{name}"
            );
        }
    }

    #[test]
    fn mcp_permissions_are_independent_and_check_payload_lifecycle_before_execution() {
        for mask in 0..8 {
            let permissions = McpPermissions {
                allow_write: mask & 1 != 0,
                allow_archive: mask & 2 != 0,
                allow_delete: mask & 4 != 0,
            };
            for (name, arguments, required) in [
                ("mindwtr_get_task", json!({"id":"task"}), 0),
                ("mindwtr_add_task", json!({"title":"Task"}), 1),
                (
                    "mindwtr_update_task",
                    json!({"id":"task","title":"Edit"}),
                    1,
                ),
                ("mindwtr_complete_task", json!({"id":"task"}), 1),
                ("mindwtr_restore_task", json!({"id":"task"}), 1),
                ("mindwtr_archive_task", json!({"id":"task"}), 2),
                ("mindwtr_delete_task", json!({"id":"task"}), 4),
                ("mindwtr_delete_project", json!({"id":"project"}), 4),
                ("mindwtr_add_project", json!({"title":"Project"}), 1),
                (
                    "mindwtr_update_project",
                    json!({"id":"project","title":"Edit"}),
                    1,
                ),
                (
                    "mindwtr_add_task",
                    json!({"title":"Task","status":"archived"}),
                    3,
                ),
                (
                    "mindwtr_add_task",
                    json!({"title":"Task","cancelledAt":"2026-10-13T12:00:00Z"}),
                    3,
                ),
                (
                    "mindwtr_update_task",
                    json!({"id":"task","cancelledAt":"2026-10-13T12:00:00Z"}),
                    2,
                ),
                (
                    "mindwtr_update_task",
                    json!({"id":"task","title":"Edit","cancelledAt":"2026-10-13T12:00:00Z"}),
                    3,
                ),
                (
                    "mindwtr_update_task",
                    json!({"id":"task","cancelledAt":null}),
                    1,
                ),
                (
                    "mindwtr_add_project",
                    json!({"title":"Project","status":"archived"}),
                    3,
                ),
                (
                    "mindwtr_update_project",
                    json!({"id":"project","status":"archived"}),
                    2,
                ),
                (
                    "mindwtr_update_project",
                    json!({"id":"project","title":"Edit","status":"archived"}),
                    3,
                ),
                (
                    "mindwtr_update_project",
                    json!({"id":"project","status":"active"}),
                    1,
                ),
            ] {
                let allowed = mask & required == required;
                let mut executed = false;
                let response = handle_mcp_request(
                    "fixture-token",
                    &access(permissions.any_write()),
                    permissions,
                    MCP_PORT,
                    request(
                        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":arguments}}),
                    ),
                    |_| {
                        executed = true;
                        Ok(json!({"task":{},"project":{}}))
                    },
                );
                assert_eq!(
                    executed, allowed,
                    "mask={mask} name={name} arguments={arguments}"
                );
                assert_eq!(response.body["result"]["isError"] == true, !allowed);
                if !allowed {
                    let error: Value = serde_json::from_str(
                        response.body["result"]["content"][0]["text"]
                            .as_str()
                            .unwrap(),
                    )
                    .unwrap();
                    let expected = if required & 1 != 0 && mask & 1 == 0 {
                        "read_only"
                    } else if required & 2 != 0 && mask & 2 == 0 {
                        "archive_not_allowed"
                    } else {
                        "delete_not_allowed"
                    };
                    assert_eq!(error["code"], expected);
                }
            }
        }
        for (name, arguments) in [
            (
                "mindwtr_update_task",
                json!({"id":"task","deletedAt":"2026-10-13T12:00:00Z"}),
            ),
            (
                "mindwtr_add_task",
                json!({"title":"Task","props":{"status":"archived"}}),
            ),
            (
                "mindwtr_update_project",
                json!({"id":"project","deletedAt":"2026-10-13T12:00:00Z"}),
            ),
            (
                "mindwtr_batch_update_tasks",
                json!({"ids":["task"],"status":"archived"}),
            ),
            ("mindwtr_archive_task", json!({"id":"task","title":"Edit"})),
        ] {
            let response = handle_mcp_request(
                "fixture-token",
                &access(true),
                permissions(true),
                MCP_PORT,
                request(
                    json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":arguments}}),
                ),
                |_| panic!("invalid lifecycle shortcut must not execute"),
            );
            assert_eq!(response.body["error"]["code"], -32602);
        }
        let batch = handle_mcp_request(
            "fixture-token",
            &access(true),
            permissions(true),
            MCP_PORT,
            request(
                json!([{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mindwtr_delete_task","arguments":{"id":"task"}}}]),
            ),
            |_| panic!("JSON-RPC batches must not execute"),
        );
        assert_eq!(batch.body["error"]["code"], -32600);
    }

    #[test]
    fn mcp_arbitrary_port_validates_http_host_and_origin() {
        let port = 9123;
        let mut valid = request(json!({"jsonrpc":"2.0","id":1,"method":"ping"}));
        valid
            .headers
            .insert("host".into(), format!("127.0.0.1:{port}"));
        valid
            .headers
            .insert("origin".into(), format!("http://127.0.0.1:{port}"));
        assert_eq!(
            handle_mcp_request(
                "fixture-token",
                &access(false),
                permissions(false),
                port,
                valid,
                |_| panic!()
            )
            .body["result"],
            json!({})
        );
        for (field, value) in [
            ("host", "127.0.0.1:8722"),
            ("origin", "http://127.0.0.1:8722"),
        ] {
            let mut invalid = request(json!({"jsonrpc":"2.0","id":1,"method":"ping"}));
            invalid
                .headers
                .insert("host".into(), format!("127.0.0.1:{port}"));
            invalid.headers.insert(field.into(), value.into());
            assert_eq!(
                handle_mcp_request(
                    "fixture-token",
                    &access(false),
                    permissions(false),
                    port,
                    invalid,
                    |_| panic!()
                )
                .status,
                403
            );
        }
    }
    #[test]
    fn mcp_patch_focus_limit_preserves_exact_message() {
        let mut data = json!({
            "tasks": (0..4).map(|index| json!({
                "id": format!("task-{index}"), "title": "Original", "status": "next",
                "isFocusedToday": index < 3, "rev": 1,
                "createdAt": "2026-10-11T12:00:00Z", "updatedAt": "2026-10-11T12:00:00Z"
            })).collect::<Vec<_>>(),
            "projects": [], "sections": [], "areas": [],
            "settings": {"gtd": {"focusTaskLimit": 3}}
        });
        let before = data.clone();
        let response = handle_mcp_request(
            "fixture-token",
            &access(true),
            permissions(true),
            MCP_PORT,
            request(
                json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
                    "name": "mindwtr_update_task",
                    "arguments": {"id": "task-3", "isFocusedToday": true, "title": "Changed"}
                }}),
            ),
            |operation| {
                let LocalOperation::PatchTask { id, body } = operation else {
                    panic!("task patch")
                };
                Ok(json!({"task": local_api::patch_task_in_data(&mut data, &id, &body)?}))
            },
        );
        let result = &response.body["result"];
        assert_eq!(result["isError"], true);
        let message: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            message["error"], "Focus limit of 3 reached",
            "MCP must preserve the Focus limit message"
        );
        assert_eq!(message["code"], "validation_error");
        assert_eq!(data, before);
    }

    #[test]
    fn mcp_patch_other_conflicts_keep_generic_message() {
        let response = handle_mcp_request(
            "fixture-token",
            &access(true),
            permissions(true),
            MCP_PORT,
            request(
                json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
                    "name": "mindwtr_update_task", "arguments": {"id": "task", "status": "next"}
                }}),
            ),
            |_| Err("Task status conflict: private fixture detail".into()),
        );
        let message: Value = serde_json::from_str(
            response.body["result"]["content"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            message["error"],
            "Invalid input or lifecycle conflict. Check the item in the desktop app."
        );
        assert_eq!(message["code"], "validation_error");
    }

    fn fixture_listener(port: u16, token: String, allow_write: bool) -> LocalApiHandle {
        local_api::start_http_listener(port,allow_write,move |access,port,request| handle_mcp_request(&token,access,permissions(allow_write),port,request,|operation| {
            let data=json!({"tasks":[{"id":"native-fixture-task","title":"Native MCP fixture","status":"inbox","tags":[],"contexts":[],"createdAt":"2026-10-05T12:00:00Z","updatedAt":"2026-10-05T12:00:00Z","rev":1}],"projects":[],"areas":[]});
            match operation {
                LocalOperation::QueryTasks(input)=>Ok(json!({"tasks":crate::local_query::query_tasks(&data,&input)?})),
                LocalOperation::GetTask(id) if id=="native-fixture-task"=>Ok(json!({"task":data["tasks"][0]})),
                LocalOperation::ListProjects=>Ok(json!({"projects":[]})),
                LocalOperation::ListAreas=>Ok(json!({"areas":[]})),
                _=>Err("Task not found".into()),
            }
        })).unwrap()
    }
    #[test]
    fn mcp_listener_disable_rotation_and_port_collision() {
        let mut runtime = McpRuntime::default();
        let config = McpConfig {
            enabled: true,
            token: Some("old".into()),
            allow_write: true,
            ..McpConfig::default()
        };
        runtime.reconcile_with(&config, |_| Ok(fixture_listener(0, "old".into(), true)));
        let port = runtime.listener.as_ref().unwrap().port;
        let revoked = runtime.listener.as_ref().unwrap().test_access(true);
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_err());
        let next = McpConfig {
            token: Some("new".into()),
            ..config.clone()
        };
        let status = runtime.status_after_read(Ok(next.clone()));
        assert!(!status.running);
        assert_eq!(status.error.as_deref(), Some("exited"));
        assert!(revoked.ensure_write().is_err());
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
        runtime.reconcile_with(&next, |_| Ok(fixture_listener(0, "new".into(), true)));
        let revoked = runtime.listener.as_ref().unwrap().test_access(true);
        let disabled = McpConfig {
            enabled: false,
            ..next
        };
        runtime.reconcile_with(&disabled, |_| panic!("disabled must not start"));
        assert!(!runtime.status(disabled).running);
        assert!(revoked.ensure_write().is_err());
        let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        assert_eq!(
            local_api::start_http_listener(
                occupied.local_addr().unwrap().port(),
                false,
                |_, _, _| ApiResponse::ok(json!({}))
            )
            .err()
            .as_deref(),
            Some("port_in_use")
        );
    }
    #[test]
    fn mcp_permission_and_port_changes_revoke_old_listener_before_restart() {
        let mut runtime = McpRuntime::default();
        let config = McpConfig {
            enabled: true,
            allow_write: true,
            allow_archive: true,
            allow_delete: true,
            token: Some("fixture".into()),
            ..McpConfig::default()
        };
        runtime.reconcile_with(&config, |_| Ok(fixture_listener(0, "fixture".into(), true)));
        let old_port = runtime.listener.as_ref().unwrap().port;
        let revoked = runtime.listener.as_ref().unwrap().test_access(true);
        let reserved = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let next_port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let restricted = McpConfig {
            allow_write: false,
            allow_archive: false,
            allow_delete: true,
            port: next_port,
            ..config
        };
        runtime.reconcile_with(&restricted, |next| {
            assert!(
                revoked.ensure_write().is_err(),
                "old permissions revoke before replacement starts"
            );
            assert!(std::net::TcpListener::bind(("127.0.0.1", old_port)).is_ok());
            Ok(fixture_listener(next.port, "fixture".into(), true))
        });
        let status = runtime.status(restricted);
        assert!(status.running);
        assert_eq!(status.port, next_port);
        assert_eq!(
            status.url.as_deref(),
            Some(format!("http://127.0.0.1:{next_port}/mcp").as_str())
        );
        assert!(!status.allow_write);
        assert!(!status.allow_archive);
        assert!(status.allow_delete);
        let access = runtime.listener.as_ref().unwrap().test_access(true);
        let failed = runtime.status_after_read(Err(McpError::ConfigFailed));
        assert!(!failed.running);
        assert_eq!(failed.error.as_deref(), Some("config_failed"));
        assert!(access.ensure_write().is_err());
    }
    #[test]
    fn mcp_configuration_is_persisted_before_start_and_keeps_unrelated_fields() {
        let original = AppConfigToml {
            local_api_enabled: Some("true".into()),
            local_api_token: Some("rest-token".into()),
            ..AppConfigToml::default()
        };
        let config = update_config_with(
            || Ok(original),
            Some(config_request(true, false, false)),
            |stored| {
                assert_eq!(stored.local_api_token.as_deref(), Some("rest-token"));
                assert_eq!(stored.mcp_enabled.as_deref(), Some("true"));
                assert_eq!(stored.mcp_token.as_ref().unwrap().len(), 64);
                Ok(())
            },
        )
        .unwrap();
        assert!(config.enabled);
        assert!(!config.allow_write);
        assert_eq!(
            update_config_with(
                || Ok(AppConfigToml::default()),
                Some(config_request(true, true, true)),
                |_| Err("secret fixture".into())
            )
            .err(),
            Some(McpError::ConfigFailed)
        );
        let directory = tempfile::tempdir().unwrap();
        let original = crate::config::read_config_files_verified(
            &directory.path().join("config.toml"),
            &directory.path().join("secrets.toml"),
        )
        .unwrap();
        assert!(!config_from_toml(&original).unwrap().enabled);
    }
    #[test]
    fn mcp_config_migrates_existing_deletion_grant_and_preserves_explicit_controls() {
        let new_install = config_from_toml(&AppConfigToml::default()).unwrap();
        assert!(!new_install.permissions().any_write());
        assert_eq!(new_install.port, MCP_PORT);
        let legacy = AppConfigToml {
            mcp_allow_write: Some("true".into()),
            ..AppConfigToml::default()
        };
        let migrated = config_from_toml(&legacy).unwrap();
        assert!(migrated.allow_write);
        assert!(migrated.allow_delete);
        assert!(!migrated.allow_archive);
        let explicit = AppConfigToml {
            mcp_allow_delete: Some("false".into()),
            mcp_allow_archive: Some("true".into()),
            mcp_port: Some("9123".into()),
            local_api_port: Some("4567".into()),
            ..legacy.clone()
        };
        assert!(!config_from_toml(&explicit).unwrap().allow_delete);
        let kept = update_config_with(
            || Ok(explicit),
            Some(config_request(false, false, false)),
            |stored| {
                assert_eq!(stored.mcp_allow_delete.as_deref(), Some("false"));
                assert_eq!(stored.mcp_allow_archive.as_deref(), Some("true"));
                assert_eq!(stored.mcp_port.as_deref(), Some("9123"));
                assert_eq!(stored.local_api_port.as_deref(), Some("4567"));
                Ok(())
            },
        )
        .unwrap();
        assert!(!kept.allow_write);
        assert!(!kept.allow_delete);
        assert!(kept.allow_archive);
        assert_eq!(kept.port, 9123);
        let preserved = update_config_with(
            || Ok(legacy),
            Some(config_request(false, false, false)),
            |stored| {
                assert_eq!(stored.mcp_allow_delete.as_deref(), Some("true"));
                Ok(())
            },
        )
        .unwrap();
        assert!(
            preserved.allow_delete,
            "changing edit permission does not erase migrated deletion permission"
        );
    }
    #[test]
    fn mcp_port_validation_and_config_roundtrip_fail_closed() {
        for port in [
            -1.0,
            0.0,
            1.0,
            1023.0,
            9123.5,
            65536.0,
            f64::INFINITY,
            f64::NAN,
        ] {
            let request = McpConfigRequest {
                port: Some(port),
                ..config_request(true, true, false)
            };
            assert_eq!(
                update_config_with(
                    || Ok(AppConfigToml::default()),
                    Some(request),
                    |_| panic!("invalid port must not persist")
                )
                .err(),
                Some(McpError::InvalidPort)
            );
        }
        for port in [1024.0, 9123.0, 65535.0] {
            let request = McpConfigRequest {
                port: Some(port),
                allow_archive: Some(true),
                allow_delete: Some(false),
                ..config_request(true, true, false)
            };
            let config = update_config_with(
                || Ok(AppConfigToml::default()),
                Some(request),
                |stored| {
                    let roundtrip: AppConfigToml =
                        toml::from_str(&toml::to_string(stored).unwrap()).unwrap();
                    let read = config_from_toml(&roundtrip).unwrap();
                    assert_eq!(read.port, port as u16);
                    assert!(read.allow_archive);
                    assert!(!read.allow_delete);
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(config.port, port as u16);
        }
        for invalid in ["bad", "-1", "1023", "65536"] {
            let stored = AppConfigToml {
                mcp_port: Some(invalid.into()),
                ..AppConfigToml::default()
            };
            assert_eq!(config_from_toml(&stored).err(), Some(McpError::InvalidPort));
            assert_eq!(
                update_config_with(|| Ok(stored.clone()), None, |_| panic!()).err(),
                Some(McpError::InvalidPort)
            );
            let repaired = update_config_with(
                || Ok(stored),
                Some(McpConfigRequest {
                    port: Some(9123.0),
                    ..config_request(false, false, false)
                }),
                |_| Ok(()),
            )
            .unwrap();
            assert_eq!(repaired.port, 9123);
        }
    }
    #[test]
    #[ignore = "Driven by scripts/test-native-mcp.ts with the official MCP SDK"]
    fn mcp_sdk_listener_fixture() {
        let port = std::env::var("MINDWTR_MCP_TEST_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let token = std::env::var("MINDWTR_MCP_TEST_TOKEN").unwrap();
        let listener = fixture_listener(port, token, false);
        std::fs::write(
            std::env::var("MINDWTR_MCP_TEST_READY").unwrap(),
            listener.port.to_string(),
        )
        .unwrap();
        let stop = std::env::var("MINDWTR_MCP_TEST_STOP").unwrap();
        let deadline = Instant::now() + Duration::from_secs(90);
        while !std::path::Path::new(&stop).exists() {
            assert!(
                Instant::now() < deadline,
                "SDK fixture did not receive stop signal"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(listener);
    }
}
