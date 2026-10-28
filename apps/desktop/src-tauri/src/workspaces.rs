//! Isolated desktop workspaces (#1473).
//!
//! A workspace is a whole local profile: its own database, attachments,
//! `config.toml`/`secrets.toml`, keyring entries and caches. One workspace is
//! active per process. Switching writes the new active id to the registry and
//! restarts the app, so nothing that belongs to the old workspace (a sync, an
//! upload, a poller, the local API) can finish inside the new one.
//!
//! The default workspace is today's profile, at today's paths, with no
//! migration. Every other workspace lives one level down:
//! `<config root>/workspaces/<id>/` and `<data root>/workspaces/<id>/`.
//! `storage::get_config_dir` / `get_data_dir` are the single place that applies
//! this; device-level files go through the `get_device_*` accessors instead.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::Manager;

pub(crate) const DEFAULT_WORKSPACE_ID: &str = "default";
pub(crate) const WORKSPACES_DIR_NAME: &str = "workspaces";
pub(crate) const REGISTRY_FILE_NAME: &str = "workspaces.toml";
const ID_BYTES: usize = 8;
const MAX_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Registry {
    /// `None` (or `"default"`) means the default workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active: Option<String>,
    /// Non-default workspaces, plus an optional `default` entry that only
    /// carries the default workspace's name and color.
    #[serde(default, rename = "workspace", skip_serializing_if = "Vec::is_empty")]
    workspaces: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WorkspaceEntry {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) color: Option<String>,
}

/// Generated ids only: 16 lowercase hex characters. Never derived from the
/// user's name, and strict enough that an id can be joined to a path safely.
pub(crate) fn is_workspace_id(id: &str) -> bool {
    id.len() == ID_BYTES * 2 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn new_workspace_id() -> String {
    let mut bytes = [0u8; ID_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The directory a workspace uses under a device-level root. `None` is the
/// default workspace, which is the root itself.
pub(crate) fn workspace_dir(device_dir: &Path, workspace: Option<&str>) -> PathBuf {
    match workspace {
        Some(id) => device_dir.join(WORKSPACES_DIR_NAME).join(id),
        None => device_dir.to_path_buf(),
    }
}

/// The device-level config dir a workspace config dir belongs to, or `None`
/// when `config_dir` is not a non-default workspace's dir. Used by the config
/// layer to route device-level keys to the default root's `config.toml`.
pub(crate) fn device_dir_of_workspace_dir(config_dir: &Path) -> Option<PathBuf> {
    let id = config_dir.file_name()?.to_str()?;
    let parent = config_dir.parent()?;
    if !is_workspace_id(id) || parent.file_name()?.to_str()? != WORKSPACES_DIR_NAME {
        return None;
    }
    parent.parent().map(Path::to_path_buf)
}

fn registry_path(device_config_dir: &Path) -> PathBuf {
    device_config_dir.join(REGISTRY_FILE_NAME)
}

/// A missing file is the default workspace alone. Unknown or malformed ids are
/// dropped so a hand-edited file can never point a path outside `workspaces/`.
pub(crate) fn read_registry(device_config_dir: &Path) -> Result<Registry, String> {
    let raw = match fs::read_to_string(registry_path(device_config_dir)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Registry::default())
        }
        Err(error) => return Err(format!("Failed to read the workspace list: {error}")),
    };
    let mut registry: Registry =
        toml::from_str(&raw).map_err(|_| "The workspace list is unreadable".to_string())?;
    let mut seen = std::collections::HashSet::new();
    registry.workspaces.retain(|entry| {
        (entry.id == DEFAULT_WORKSPACE_ID || is_workspace_id(&entry.id))
            && seen.insert(entry.id.clone())
    });
    Ok(registry)
}

fn write_registry(device_config_dir: &Path, registry: &Registry) -> Result<(), String> {
    let content = toml::to_string(registry).map_err(|e| e.to_string())?;
    crate::config::write_atomic_text(
        &registry_path(device_config_dir),
        &format!("# Mindwtr desktop workspaces\n{content}"),
        false,
    )
}

/// The active non-default workspace id, or `None` for the default one. An
/// active id that is not in the list falls back to the default workspace.
pub(crate) fn resolve_active(registry: &Registry) -> Option<String> {
    let id = registry.active.as_deref()?;
    (is_workspace_id(id) && registry.workspaces.iter().any(|entry| entry.id == id))
        .then(|| id.to_string())
}

fn workspace_count(registry: &Registry) -> usize {
    1 + registry
        .workspaces
        .iter()
        .filter(|entry| entry.id != DEFAULT_WORKSPACE_ID)
        .count()
}

fn normalize_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Workspace name is required".to_string());
    }
    Ok(name.chars().take(MAX_NAME_CHARS).collect())
}

fn normalize_color(color: Option<String>) -> Result<Option<String>, String> {
    let Some(color) = color
        .map(|c| c.trim().to_ascii_lowercase())
        .filter(|c| !c.is_empty())
    else {
        return Ok(None);
    };
    let valid = color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|b| b.is_ascii_hexdigit());
    if !valid {
        return Err("Workspace color must be #rrggbb".to_string());
    }
    Ok(Some(color))
}

pub(crate) fn add_workspace(
    registry: &mut Registry,
    name: &str,
    color: Option<String>,
) -> Result<WorkspaceEntry, String> {
    let entry = WorkspaceEntry {
        id: new_workspace_id(),
        name: normalize_name(name)?,
        color: normalize_color(color)?,
    };
    registry.workspaces.push(entry.clone());
    Ok(entry)
}

pub(crate) fn update_workspace_entry(
    registry: &mut Registry,
    id: &str,
    name: &str,
    color: Option<String>,
) -> Result<(), String> {
    let name = normalize_name(name)?;
    let color = normalize_color(color)?;
    if let Some(entry) = registry.workspaces.iter_mut().find(|entry| entry.id == id) {
        entry.name = name;
        entry.color = color;
        return Ok(());
    }
    if id != DEFAULT_WORKSPACE_ID {
        return Err("Workspace not found".to_string());
    }
    registry.workspaces.insert(
        0,
        WorkspaceEntry {
            id: DEFAULT_WORKSPACE_ID.to_string(),
            name,
            color,
        },
    );
    Ok(())
}

/// `running` is the workspace this process opened. Deleting it, the one the
/// registry will open next, or the default workspace is refused.
pub(crate) fn remove_workspace_entry(
    registry: &mut Registry,
    id: &str,
    running: Option<&str>,
) -> Result<(), String> {
    if id == DEFAULT_WORKSPACE_ID || !is_workspace_id(id) {
        return Err("The default workspace cannot be deleted".to_string());
    }
    if running == Some(id) || resolve_active(registry).as_deref() == Some(id) {
        return Err("The active workspace cannot be deleted".to_string());
    }
    let before = registry.workspaces.len();
    registry.workspaces.retain(|entry| entry.id != id);
    if registry.workspaces.len() == before {
        return Err("Workspace not found".to_string());
    }
    Ok(())
}

pub(crate) fn set_active_workspace(registry: &mut Registry, id: &str) -> Result<(), String> {
    if id == DEFAULT_WORKSPACE_ID {
        registry.active = None;
        return Ok(());
    }
    if !is_workspace_id(id) || !registry.workspaces.iter().any(|entry| entry.id == id) {
        return Err("Workspace not found".to_string());
    }
    registry.active = Some(id.to_string());
    Ok(())
}

#[derive(Debug)]
struct ActiveWorkspace {
    id: Option<String>,
    name: Option<String>,
    count: usize,
    registry_unreadable: bool,
}

static ACTIVE: OnceLock<ActiveWorkspace> = OnceLock::new();

/// Read once per process, at the first path lookup: the active workspace
/// only changes through a restart.
fn active() -> &'static ActiveWorkspace {
    ACTIVE.get_or_init(|| {
        let (config_dir, data_dir) = crate::storage::device_dirs_for_startup();
        // A failed standard-layout migration leaves this run on the flat root,
        // where config and data share one folder. Workspaces are off for that
        // run rather than built somewhere the next start will not look.
        if config_dir == data_dir {
            return ActiveWorkspace {
                id: None,
                name: None,
                count: 1,
                registry_unreadable: false,
            };
        }
        match read_registry(&config_dir) {
            Ok(registry) => {
                let id = resolve_active(&registry);
                let name = id.as_deref().and_then(|id| {
                    registry
                        .workspaces
                        .iter()
                        .find(|entry| entry.id == id)
                        .map(|entry| entry.name.clone())
                });
                ActiveWorkspace {
                    id,
                    name,
                    count: workspace_count(&registry),
                    registry_unreadable: false,
                }
            }
            Err(_) => ActiveWorkspace {
                id: None,
                name: None,
                count: 1,
                registry_unreadable: true,
            },
        }
    })
}

/// The workspace this process opened: `None` is the default workspace.
/// Tests never read the real registry; they pass a workspace explicitly to the
/// pure helpers instead.
pub(crate) fn active_workspace_id() -> Option<&'static str> {
    if cfg!(test) {
        return None;
    }
    active().id.as_deref()
}

/// Startup receipt for the diagnostic log. Never logs the workspace name.
/// Written straight to the log file as well, because the log plugin is
/// optional and Settings > Diagnostics exports read that file.
pub(crate) fn log_workspace_opened(app: &tauri::AppHandle) {
    let state = active();
    let workspace = if state.id.is_some() {
        "custom"
    } else {
        "default"
    };
    let outcome = if state.registry_unreadable {
        "registry-unreadable"
    } else {
        "opened"
    };
    let count = state.count;
    let diagnostic = format!(
        "Workspace opened extra.releaseCheck=v1.3.8/desktop-workspaces workspace={workspace} count={count} outcome={outcome}"
    );
    log::info!("{diagnostic}");
    crate::logging::append_native_log_line(app, &diagnostic);
}

/// `Mindwtr — <name>` while a non-default workspace is open.
pub(crate) fn window_title() -> Option<String> {
    if cfg!(test) {
        return None;
    }
    let state = active();
    state.id.as_ref()?;
    let name = state.name.as_deref().unwrap_or("").trim();
    Some(if name.is_empty() {
        "Mindwtr".to_string()
    } else {
        format!("Mindwtr \u{2014} {name}")
    })
}

/// Runs before any page script in every webview, so the renderer knows which
/// workspace's cache keys to use before its first `localStorage` read.
pub(crate) fn init_script_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let id = active_workspace_id().unwrap_or(DEFAULT_WORKSPACE_ID);
    let script = format!(
        "window.__MINDWTR_WORKSPACE_ID__ = {};",
        serde_json::to_string(id).unwrap_or_else(|_| "\"default\"".to_string())
    );
    tauri::plugin::Builder::new("mindwtr-workspace")
        .js_init_script(script)
        .build()
}

fn registry_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn device_config_dir_for_registry(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = crate::storage::get_device_config_dir(app);
    if config_dir == crate::storage::get_device_data_dir(app) {
        return Err("Workspaces are unavailable until the profile folder is migrated".to_string());
    }
    Ok(config_dir)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceInfo {
    id: String,
    name: String,
    color: Option<String>,
    is_default: bool,
    data_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceList {
    active_id: String,
    available: bool,
    /// `workspaces.toml` exists but could not be parsed.
    unreadable: bool,
    workspaces: Vec<WorkspaceInfo>,
}

fn workspace_info(app: &tauri::AppHandle, entry: &WorkspaceEntry) -> WorkspaceInfo {
    let is_default = entry.id == DEFAULT_WORKSPACE_ID;
    let data_dir = workspace_dir(
        &crate::storage::get_device_data_dir(app),
        (!is_default).then_some(entry.id.as_str()),
    );
    WorkspaceInfo {
        id: entry.id.clone(),
        name: entry.name.clone(),
        color: entry.color.clone(),
        is_default,
        data_dir: data_dir.to_string_lossy().into_owned(),
    }
}

fn list_for(app: &tauri::AppHandle, registry: &Registry, available: bool) -> WorkspaceList {
    let default_entry = registry
        .workspaces
        .iter()
        .find(|entry| entry.id == DEFAULT_WORKSPACE_ID)
        .cloned()
        .unwrap_or(WorkspaceEntry {
            id: DEFAULT_WORKSPACE_ID.to_string(),
            name: String::new(),
            color: None,
        });
    let mut workspaces = vec![workspace_info(app, &default_entry)];
    workspaces.extend(
        registry
            .workspaces
            .iter()
            .filter(|entry| entry.id != DEFAULT_WORKSPACE_ID)
            .map(|entry| workspace_info(app, entry)),
    );
    WorkspaceList {
        active_id: active_workspace_id()
            .unwrap_or(DEFAULT_WORKSPACE_ID)
            .to_string(),
        available,
        unreadable: false,
        workspaces,
    }
}

fn mutate_registry<T>(
    app: &tauri::AppHandle,
    change: impl FnOnce(&mut Registry) -> Result<T, String>,
) -> Result<T, String> {
    let config_dir = device_config_dir_for_registry(app)?;
    let _guard = registry_lock();
    let mut registry = read_registry(&config_dir)?;
    let result = change(&mut registry)?;
    write_registry(&config_dir, &registry)?;
    Ok(result)
}

#[tauri::command(async)]
pub(crate) fn list_workspaces(app: tauri::AppHandle) -> Result<WorkspaceList, String> {
    match device_config_dir_for_registry(&app) {
        Ok(config_dir) => {
            let _guard = registry_lock();
            Ok(match read_registry(&config_dir) {
                Ok(registry) => list_for(&app, &registry, true),
                // The default workspace opened instead; Settings says why.
                Err(_) => WorkspaceList {
                    unreadable: true,
                    ..list_for(&app, &Registry::default(), false)
                },
            })
        }
        Err(_) => Ok(list_for(&app, &Registry::default(), false)),
    }
}

#[tauri::command(async)]
pub(crate) fn create_workspace(
    app: tauri::AppHandle,
    name: String,
    color: Option<String>,
) -> Result<WorkspaceInfo, String> {
    let entry = mutate_registry(&app, |registry| add_workspace(registry, &name, color))?;
    let diagnostic = format!("Workspace created extra.releaseCheck=v1.3.8/desktop-workspaces");
    log::info!("{diagnostic}");
    crate::logging::append_native_log_line(&app, &diagnostic);
    Ok(workspace_info(&app, &entry))
}

#[tauri::command(async)]
pub(crate) fn update_workspace(
    app: tauri::AppHandle,
    id: String,
    name: String,
    color: Option<String>,
) -> Result<(), String> {
    mutate_registry(&app, |registry| {
        update_workspace_entry(registry, &id, &name, color)
    })
}

/// Removes the workspace from the list first, then its two folders and its
/// keyring entries. A failure after the first step leaves orphaned files, never
/// a listed workspace that points at half-deleted data.
#[tauri::command(async)]
pub(crate) fn delete_workspace(app: tauri::AppHandle, id: String) -> Result<(), String> {
    mutate_registry(&app, |registry| {
        remove_workspace_entry(registry, &id, active_workspace_id())
    })?;
    crate::config::delete_workspace_keyring_entries(&app, &id);
    let mut failed = false;
    for root in [
        crate::storage::get_device_config_dir(&app),
        crate::storage::get_device_data_dir(&app),
    ] {
        let dir = workspace_dir(&root, Some(&id));
        if let Err(error) = fs::remove_dir_all(&dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                failed = true;
            }
        }
    }
    let outcome = if failed { "files-left" } else { "removed" };
    let diagnostic =
        format!("Workspace deleted extra.releaseCheck=v1.3.8/desktop-workspaces outcome={outcome}");
    log::info!("{diagnostic}");
    crate::logging::append_native_log_line(&app, &diagnostic);
    if failed {
        return Err("The workspace was removed, but some of its files could not be deleted".into());
    }
    Ok(())
}

/// Records the new active workspace and restarts. The renderer has already
/// flushed its pending local saves; no network sync is awaited, so an
/// unreachable server never blocks opening another workspace.
#[tauri::command(async)]
pub(crate) fn switch_workspace(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if active_workspace_id().unwrap_or(DEFAULT_WORKSPACE_ID) == id {
        return Ok(());
    }
    mutate_registry(&app, |registry| set_active_workspace(registry, &id))?;
    let workspace = if id == DEFAULT_WORKSPACE_ID {
        "default"
    } else {
        "custom"
    };
    let diagnostic = format!(
        "Workspace switch requested extra.releaseCheck=v1.3.8/desktop-workspaces workspace={workspace}"
    );
    log::info!("{diagnostic}");
    crate::logging::append_native_log_line(&app, &diagnostic);
    RELAUNCH.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

static RELAUNCH: AtomicBool = AtomicBool::new(false);

/// Renderer variables `run()` may set for this process from the hardware
/// acceleration setting. A relaunch gets them as the user launched the app,
/// so it applies the setting afresh.
const RENDERER_ENV_NAMES: [&str; 3] = [
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
];
static LAUNCH_ENV: OnceLock<Vec<(&'static str, Option<std::ffi::OsString>)>> = OnceLock::new();

/// Called first in `run()`, before anything sets the renderer variables.
pub(crate) fn remember_launch_environment() {
    LAUNCH_ENV.get_or_init(|| {
        RENDERER_ENV_NAMES
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect()
    });
}

/// Called last in `RunEvent::Exit`, after the plugins have released the
/// single-instance lock. Relaunches without the original arguments: a launch
/// from autostart (`--startup`) or Quick Add must not make the new workspace
/// open hidden or straight into Quick Add. Tauri's restart resolves the
/// AppImage path and the macOS bundle binary.
pub(crate) fn relaunch_if_switching(app: &tauri::AppHandle) {
    if !RELAUNCH.load(Ordering::SeqCst) {
        return;
    }
    let mut env = app.env();
    env.args_os.truncate(1);
    for (name, value) in LAUNCH_ENV.get().into_iter().flatten() {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
    app.cleanup_before_exit();
    tauri::process::restart(&env);
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: &str = "0123456789abcdef";

    /// Who owns a file or folder the app writes in a profile root.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Scope {
        /// Shared by every workspace; always at the device-level root.
        Device,
        /// Inside the active workspace's folder.
        Workspace,
    }

    /// The checklist of `storage_layout`'s entries (plus this module's own), each
    /// classified once. Device-level code reaches these through
    /// `storage::get_device_config_dir` / `get_device_data_dir`; everything else
    /// through `get_config_dir` / `get_data_dir`. Note `config.toml` is
    /// per-workspace, but its device-level keys are routed to the default root by
    /// `config::is_device_config_key`.
    fn entry_scope(name: &str) -> Option<Scope> {
        use Scope::{Device, Workspace};
        Some(match name {
            "logs" | "whisper-models" | "parakeet-model" | "sherpa-onnx" => Device,
            "window-layouts.json" | "window-state.json" => Device,
            REGISTRY_FILE_NAME | WORKSPACES_DIR_NAME => Device,
            "attachments" | "audio-captures" | "snapshots" => Workspace,
            "file-sync-attachment-publications-v2" | "email-capture-state.json" => Workspace,
            "data.json" | "data.json.bak" | "config.json" => Workspace,
            "mindwtr.db" | "mindwtr.db-wal" | "mindwtr.db-shm" | "mindwtr.db-journal" => Workspace,
            "config.toml" | "secrets.toml" | "config-credential-state.json" => Workspace,
            "sync-backend-state.json" | "dropbox-credential-state.json" => Workspace,
            ".config.toml.mindwtr-rollback" | ".secrets.toml.mindwtr-rollback" => Workspace,
            _ => return None,
        })
    }

    /// Where an entry of `scope` lives while `workspace` is open.
    fn scoped_dir(scope: Scope, device_dir: &Path, workspace: Option<&str>) -> PathBuf {
        match scope {
            Scope::Device => device_dir.to_path_buf(),
            Scope::Workspace => workspace_dir(device_dir, workspace),
        }
    }

    #[test]
    fn ids_are_generated_hex_and_never_a_path() {
        let id = new_workspace_id();
        assert!(is_workspace_id(&id));
        for bad in [
            "",
            "default",
            "../etc",
            "0123456789ABCDEF",
            "0123456789abcde/",
            "work",
        ] {
            assert!(!is_workspace_id(bad), "{bad}");
        }
    }

    #[test]
    fn the_default_workspace_is_the_root_and_others_live_one_level_down() {
        let root = Path::new("/profile/config");
        assert_eq!(workspace_dir(root, None), root);
        assert_eq!(
            workspace_dir(root, Some(WORK)),
            root.join("workspaces").join(WORK)
        );
        assert_eq!(
            device_dir_of_workspace_dir(&root.join("workspaces").join(WORK)),
            Some(root.to_path_buf())
        );
        assert_eq!(device_dir_of_workspace_dir(root), None);
        // A user folder that merely looks similar is not a workspace dir.
        assert_eq!(
            device_dir_of_workspace_dir(Path::new("/home/me/workspaces/mindwtr")),
            None
        );
    }

    /// The AppHandle accessors cannot be built in a unit test (the mock runtime
    /// is a different type), so this pins the wiring the pure tests rely on:
    /// the two workspace accessors apply the active workspace, every derived
    /// per-workspace path is built on them, and device-level files use the
    /// device roots.
    #[test]
    fn the_accessors_apply_the_workspace_and_device_files_use_the_device_roots() {
        fn body<'a>(source: &'a str, signature: &str) -> &'a str {
            let start = source
                .find(signature)
                .unwrap_or_else(|| panic!("missing {signature}"));
            let end = source[start..].find("\n}\n").expect("function end") + start;
            &source[start..end]
        }
        let storage = include_str!("storage.rs");
        for signature in [
            "pub(crate) fn get_config_dir(app: &tauri::AppHandle)",
            "pub(crate) fn get_data_dir(app: &tauri::AppHandle)",
        ] {
            let body = body(storage, signature);
            assert!(
                body.contains("workspace_dir(") && body.contains("active_workspace_id()"),
                "{signature} must apply the active workspace"
            );
        }
        for (signature, base) in [
            ("pub(crate) fn get_config_path(", "get_config_dir(app)"),
            ("pub(crate) fn get_secrets_path(", "get_config_dir(app)"),
            ("pub(crate) fn get_data_path(", "get_data_dir(app)"),
            ("pub(crate) fn get_db_path(", "get_data_dir(app)"),
        ] {
            assert!(
                body(storage, signature).contains(base),
                "{signature} must use {base}"
            );
        }
        let logging = include_str!("logging.rs");
        assert!(!logging.contains("get_data_dir("), "logs are device-level");
        let audio = include_str!("audio.rs");
        for signature in [
            "fn download_parakeet_model_blocking(",
            "fn download_whisper_model_blocking(",
        ] {
            assert!(
                body(audio, signature).contains("get_device_data_dir("),
                "{signature}: speech models are device-level"
            );
        }
        let window_state = include_str!("window_state.rs");
        assert!(
            !window_state.contains("get_config_dir("),
            "window state is device-level"
        );
    }

    #[test]
    fn a_missing_registry_is_the_default_workspace_alone() {
        let dir = tempfile::tempdir().expect("temp dir");
        let registry = read_registry(dir.path()).expect("missing file reads");
        assert_eq!(registry, Registry::default());
        assert_eq!(resolve_active(&registry), None);
        assert_eq!(workspace_count(&registry), 1);
    }

    #[test]
    fn add_rename_switch_and_delete_round_trip_through_the_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut registry = read_registry(dir.path()).expect("read");
        let work = add_workspace(&mut registry, "  Work  ", Some("#AABBCC".into())).expect("add");
        assert_eq!(work.name, "Work");
        assert_eq!(work.color.as_deref(), Some("#aabbcc"));
        update_workspace_entry(&mut registry, DEFAULT_WORKSPACE_ID, "Personal", None)
            .expect("rename default");
        update_workspace_entry(&mut registry, &work.id, "Office", None).expect("rename");
        set_active_workspace(&mut registry, &work.id).expect("switch");
        write_registry(dir.path(), &registry).expect("write");

        let mut reread = read_registry(dir.path()).expect("reread");
        assert_eq!(reread, registry);
        assert_eq!(resolve_active(&reread).as_deref(), Some(work.id.as_str()));
        assert_eq!(workspace_count(&reread), 2);

        // The active workspace and the default one are never deleted.
        assert!(remove_workspace_entry(&mut reread, &work.id, None).is_err());
        assert!(remove_workspace_entry(&mut reread, DEFAULT_WORKSPACE_ID, None).is_err());

        set_active_workspace(&mut reread, DEFAULT_WORKSPACE_ID).expect("switch back");
        // Still refused while this process runs inside it.
        assert!(remove_workspace_entry(&mut reread, &work.id, Some(&work.id)).is_err());
        remove_workspace_entry(&mut reread, &work.id, None).expect("delete");
        write_registry(dir.path(), &reread).expect("write");
        let last = read_registry(dir.path()).expect("read");
        assert_eq!(resolve_active(&last), None);
        assert_eq!(workspace_count(&last), 1);
        assert!(set_active_workspace(&mut reread, &work.id).is_err());
    }

    #[test]
    fn a_hand_edited_registry_cannot_escape_the_workspaces_folder() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(
            registry_path(dir.path()),
            "active = \"../..\"\n[[workspace]]\nid = \"../..\"\nname = \"x\"\n",
        )
        .expect("write");
        let registry = read_registry(dir.path()).expect("read");
        assert!(registry.workspaces.is_empty());
        assert_eq!(resolve_active(&registry), None);
    }

    #[test]
    fn every_storage_layout_entry_is_classified_and_device_entries_stay_at_the_root() {
        let root = Path::new("/profile/data");
        for name in crate::storage_layout::migrated_entry_names() {
            let scope = entry_scope(name)
                .unwrap_or_else(|| panic!("{name}: classify it as device-level or per-workspace"));
            let resolved = scoped_dir(scope, root, Some(WORK)).join(name);
            match scope {
                Scope::Device => assert_eq!(resolved, root.join(name), "{name}"),
                Scope::Workspace => {
                    assert_eq!(
                        resolved,
                        root.join("workspaces").join(WORK).join(name),
                        "{name}"
                    )
                }
            }
            // The default workspace keeps today's path for every entry.
            assert_eq!(
                scoped_dir(scope, root, None).join(name),
                root.join(name),
                "{name}"
            );
        }
    }

    #[test]
    fn names_and_colors_are_validated() {
        let mut registry = Registry::default();
        assert!(add_workspace(&mut registry, "   ", None).is_err());
        assert!(add_workspace(&mut registry, "Work", Some("red".into())).is_err());
        let long = "x".repeat(200);
        let entry = add_workspace(&mut registry, &long, None).expect("add");
        assert_eq!(entry.name.chars().count(), MAX_NAME_CHARS);
    }
}
