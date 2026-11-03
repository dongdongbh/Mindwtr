use crate::obsidian_paths::{
    is_obsidian_markdown_relative_path, join_obsidian_vault_path,
    relative_obsidian_path_from_absolute, should_skip_obsidian_relative_path,
};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const OBSIDIAN_FILES_CHANGED_EVENT: &str = "obsidian:files-changed";
const OBSIDIAN_WATCHER_ERROR_EVENT: &str = "obsidian:watcher-error";
const OBSIDIAN_WATCH_DEBOUNCE: Duration = Duration::from_millis(500);
const OBSIDIAN_WATCH_POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObsidianFilesChangedPayload {
    pub(crate) changed: Vec<String>,
    pub(crate) deleted: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianWatcherErrorPayload {
    message: String,
}

#[derive(Default)]
pub(crate) struct ObsidianWatcherState {
    watcher: Mutex<Option<ObsidianWatcherHandle>>,
}

struct ObsidianWatcherHandle {
    _watcher: RecommendedWatcher,
    stop_flag: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for ObsidianWatcherHandle {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl ObsidianWatcherHandle {
    fn new(app: AppHandle, vault_root: PathBuf) -> Result<Self, String> {
        let (event_tx, event_rx) = mpsc::channel::<notify::Result<Event>>();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let worker_stop_flag = Arc::clone(&stop_flag);
        let worker_vault_root = vault_root.clone();
        let app_for_changes = app.clone();
        let app_for_errors = app.clone();
        let worker = thread::Builder::new()
            .name("obsidian-watcher".to_string())
            .spawn(move || {
                run_watch_event_loop(
                    worker_vault_root,
                    event_rx,
                    worker_stop_flag,
                    move |payload| {
                        if let Err(error) =
                            app_for_changes.emit(OBSIDIAN_FILES_CHANGED_EVENT, payload)
                        {
                            log::warn!("Failed to emit Obsidian file change event: {error}");
                        }
                    },
                    move |message| {
                        emit_watcher_error(&app_for_errors, message);
                    },
                );
            })
            .map_err(|error| format!("Failed to start Obsidian watcher thread: {error}"))?;

        let mut watcher = RecommendedWatcher::new(
            move |result| {
                let _ = event_tx.send(result);
            },
            Config::default(),
        )
        .map_err(|error| format!("Failed to create Obsidian watcher: {error}"))?;

        watcher
            .watch(&vault_root, RecursiveMode::Recursive)
            .map_err(|error| format!("Failed to watch Obsidian vault: {error}"))?;

        Ok(Self {
            _watcher: watcher,
            stop_flag,
            worker: Some(worker),
        })
    }
}

fn emit_watcher_error(app: &AppHandle, message: String) {
    if let Err(error) = app.emit(
        OBSIDIAN_WATCHER_ERROR_EVENT,
        ObsidianWatcherErrorPayload {
            message: message.clone(),
        },
    ) {
        log::warn!("Failed to emit Obsidian watcher error event: {error}");
    }
}

fn is_relevant_notify_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Any | EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn collect_relevant_event_paths(vault_root: &Path, event: &Event) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for path in &event.paths {
        let Some(relative_path) = relative_obsidian_path_from_absolute(vault_root, path) else {
            continue;
        };
        if should_skip_obsidian_relative_path(&relative_path) {
            continue;
        }
        if !is_obsidian_markdown_relative_path(&relative_path) {
            continue;
        }
        paths.push(relative_path);
    }
    paths
}

fn build_files_changed_payload(
    vault_root: &Path,
    pending_paths: &HashSet<String>,
) -> Result<Option<ObsidianFilesChangedPayload>, String> {
    if pending_paths.is_empty() {
        return Ok(None);
    }

    let mut changed: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    let mut sorted_paths = pending_paths.iter().cloned().collect::<Vec<_>>();
    sorted_paths.sort();

    for relative_path in sorted_paths {
        let absolute_path =
            join_obsidian_vault_path(vault_root.to_string_lossy().as_ref(), &relative_path)?;
        match fs::metadata(&absolute_path) {
            Ok(metadata) if metadata.is_file() => changed.push(relative_path),
            Ok(_) => deleted.push(relative_path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                deleted.push(relative_path)
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect Obsidian file change for {}: {}",
                    relative_path, error
                ))
            }
        }
    }

    if changed.is_empty() && deleted.is_empty() {
        return Ok(None);
    }

    Ok(Some(ObsidianFilesChangedPayload { changed, deleted }))
}

fn run_watch_event_loop<FChange, FError>(
    vault_root: PathBuf,
    event_rx: mpsc::Receiver<notify::Result<Event>>,
    stop_flag: Arc<AtomicBool>,
    mut emit_changes: FChange,
    mut emit_error: FError,
) where
    FChange: FnMut(ObsidianFilesChangedPayload),
    FError: FnMut(String),
{
    let mut pending_paths: HashSet<String> = HashSet::new();
    let mut last_event_at: Option<Instant> = None;

    loop {
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }

        match event_rx.recv_timeout(OBSIDIAN_WATCH_POLL) {
            Ok(Ok(event)) => {
                if !is_relevant_notify_event(&event.kind) {
                    continue;
                }
                let mut received_path = false;
                for relative_path in collect_relevant_event_paths(&vault_root, &event) {
                    pending_paths.insert(relative_path);
                    received_path = true;
                }
                if received_path {
                    last_event_at = Some(Instant::now());
                }
            }
            Ok(Err(error)) => {
                emit_error(format!("Obsidian watcher error: {error}"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        let should_flush = last_event_at
            .map(|instant| instant.elapsed() >= OBSIDIAN_WATCH_DEBOUNCE)
            .unwrap_or(false);
        if !should_flush {
            continue;
        }

        match build_files_changed_payload(&vault_root, &pending_paths) {
            Ok(Some(payload)) => emit_changes(payload),
            Ok(None) => {}
            Err(error) => emit_error(error),
        }
        pending_paths.clear();
        last_event_at = None;
    }
}

#[tauri::command(async)]
pub(crate) fn start_obsidian_watcher(
    app: AppHandle,
    state: State<'_, ObsidianWatcherState>,
    vault_path: String,
) -> Result<(), String> {
    let trimmed_vault_path = vault_path.trim();
    if trimmed_vault_path.is_empty() {
        return Err("Obsidian vault path is not configured.".to_string());
    }

    let vault_root = PathBuf::from(trimmed_vault_path);
    let metadata = fs::metadata(&vault_root)
        .map_err(|error| format!("Failed to access Obsidian vault: {error}"))?;
    if !metadata.is_dir() {
        return Err("Obsidian vault path must point to a folder.".to_string());
    }

    let previous_watcher = {
        let mut watcher_guard = state
            .watcher
            .lock()
            .map_err(|_| "Failed to access Obsidian watcher state.".to_string())?;
        watcher_guard.take()
    };
    drop(previous_watcher);

    let watcher = ObsidianWatcherHandle::new(app, vault_root)?;
    let mut watcher_guard = state
        .watcher
        .lock()
        .map_err(|_| "Failed to access Obsidian watcher state.".to_string())?;
    watcher_guard.replace(watcher);
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn stop_obsidian_watcher(state: State<'_, ObsidianWatcherState>) -> Result<(), String> {
    let previous_watcher = {
        let mut watcher_guard = state
            .watcher
            .lock()
            .map_err(|_| "Failed to access Obsidian watcher state.".to_string())?;
        watcher_guard.take()
    };
    drop(previous_watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind};
    use tempfile::tempdir;

    #[test]
    fn filters_hidden_and_non_markdown_paths() {
        let vault = PathBuf::from("/tmp/Vault");
        let event = Event {
            kind: EventKind::Create(CreateKind::File),
            paths: vec![
                PathBuf::from("/tmp/Vault/Projects/Alpha.md"),
                PathBuf::from("/tmp/Vault/.obsidian/config.md"),
                PathBuf::from("/tmp/Vault/Projects/README.txt"),
            ],
            attrs: Default::default(),
        };

        assert_eq!(
            collect_relevant_event_paths(&vault, &event),
            vec!["Projects/Alpha.md".to_string()]
        );
    }

    #[test]
    fn batches_rapid_events_into_one_payload() {
        let temp = tempdir().expect("should create temp vault");
        let vault_root = temp.path().to_path_buf();
        let file_path = vault_root.join("Inbox.md");
        fs::write(&file_path, "- [ ] Example\n").expect("should create markdown file");

        let (event_tx, event_rx) = mpsc::channel::<notify::Result<Event>>();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let payloads = Arc::new(Mutex::new(Vec::<ObsidianFilesChangedPayload>::new()));
        let payloads_ref = Arc::clone(&payloads);
        let worker_stop = Arc::clone(&stop_flag);

        let worker = thread::spawn(move || {
            run_watch_event_loop(
                vault_root,
                event_rx,
                worker_stop,
                move |payload| {
                    payloads_ref.lock().unwrap().push(payload);
                },
                |_| {},
            );
        });

        for _ in 0..10 {
            event_tx
                .send(Ok(Event {
                    kind: EventKind::Modify(ModifyKind::Any),
                    paths: vec![file_path.clone()],
                    attrs: Default::default(),
                }))
                .expect("should send watcher event");
        }

        thread::sleep(Duration::from_millis(750));
        stop_flag.store(true, Ordering::SeqCst);
        drop(event_tx);
        worker.join().expect("watch loop should exit");

        let payloads = payloads.lock().unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(
            payloads[0],
            ObsidianFilesChangedPayload {
                changed: vec!["Inbox.md".to_string()],
                deleted: vec![],
            }
        );
    }

    #[test]
    fn classifies_missing_paths_as_deleted() {
        let temp = tempdir().expect("should create temp vault");
        let vault_root = temp.path();
        let existing = vault_root.join("Inbox.md");
        fs::write(&existing, "- [ ] Example\n").expect("should create markdown file");

        let pending = HashSet::from(["Inbox.md".to_string(), "Archive/Old.md".to_string()]);

        let payload = build_files_changed_payload(vault_root, &pending)
            .expect("should classify file changes")
            .expect("should build payload");

        assert_eq!(payload.changed, vec!["Inbox.md".to_string()]);
        assert_eq!(payload.deleted, vec!["Archive/Old.md".to_string()]);
    }
}
