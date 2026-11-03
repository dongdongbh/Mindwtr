use std::fs;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use crate::{
    CONFIG_FILE_NAME, DATA_FILE_NAME, DB_FILE_NAME, LEGACY_SYNC_BACKEND_STATE_FILE_NAME,
    SECRETS_FILE_NAME, SYNC_BACKEND_STATE_FILE_NAME,
};

pub(crate) const CONFIG_DIR_NAME: &str = "config";
pub(crate) const DATA_DIR_NAME: &str = "data";
const JOURNAL_FILE_NAME: &str = "layout-migration.json";
const JOURNAL_TEMP_FILE_NAME: &str = "layout-migration.json.tmp";
const LOCK_FILE_NAME: &str = "layout-migration.lock";

const LOCK_STALE_AFTER: Duration = Duration::from_secs(120);

const LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(3);
const LOCK_WAIT_POLL: Duration = Duration::from_millis(50);

const LEGACY_CONFIG_JSON_FILE_NAME: &str = "config.json";

pub(crate) const DATA_JSON_BACKUP_FILE_NAME: &str = "data.json.bak";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Destination {
    Config,
    Data,
}

impl Destination {
    fn dir_name(self) -> &'static str {
        match self {
            Destination::Config => CONFIG_DIR_NAME,
            Destination::Data => DATA_DIR_NAME,
        }
    }
}

use Destination::{Config, Data};

const MIGRATED_ENTRIES: &[(&str, Destination)] = &[
    ("attachments", Data),
    ("audio-captures", Data),
    ("logs", Data),
    ("snapshots", Data),
    ("whisper-models", Data),
    ("parakeet-model", Data),
    ("sherpa-onnx", Data),
    ("file-sync-attachment-publications-v2", Data),
    ("email-capture-state.json", Data),
    (DATA_JSON_BACKUP_FILE_NAME, Data),
    (SECRETS_FILE_NAME, Config),
    ("config-credential-state.json", Config),
    (SYNC_BACKEND_STATE_FILE_NAME, Config),
    (LEGACY_SYNC_BACKEND_STATE_FILE_NAME, Config),
    (".config.toml.mindwtr-rollback", Config),
    (".secrets.toml.mindwtr-rollback", Config),
    (LEGACY_CONFIG_JSON_FILE_NAME, Config),
    ("window-layouts.json", Config),
    ("window-state.json", Config),
    (CONFIG_FILE_NAME, Config),
    (DATA_FILE_NAME, Data),
    ("mindwtr.db-wal", Data),
    ("mindwtr.db-shm", Data),
    ("mindwtr.db-journal", Data),
    (DB_FILE_NAME, Data),
];

#[cfg(test)]
pub(crate) fn migrated_entry_names() -> impl Iterator<Item = &'static str> {
    MIGRATED_ENTRIES.iter().map(|(name, _)| *name)
}

fn is_database_entry(name: &str) -> bool {
    name.starts_with(DB_FILE_NAME)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LayoutOutcome {
    Already,

    Fresh,

    Migrated,

    Failed,
}

impl LayoutOutcome {
    fn as_str(self) -> &'static str {
        match self {
            LayoutOutcome::Already => "already",
            LayoutOutcome::Fresh => "fresh",
            LayoutOutcome::Migrated => "migrated",
            LayoutOutcome::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LayoutMigration {
    pub(crate) outcome: LayoutOutcome,

    pub(crate) moved: usize,

    pub(crate) kept: usize,

    pub(crate) failed_entry: Option<&'static str>,

    pub(crate) subfolders: bool,
}

impl LayoutMigration {
    fn settled(outcome: LayoutOutcome, moved: usize, kept: usize) -> Self {
        Self {
            outcome,
            moved,
            kept,
            failed_entry: None,
            subfolders: true,
        }
    }

    fn failed(entry: &'static str) -> Self {
        Self {
            outcome: LayoutOutcome::Failed,
            moved: 0,
            kept: 0,
            failed_entry: Some(entry),
            subfolders: false,
        }
    }
}

pub(crate) fn standard_layout_root(config_dir: &Path, data_dir: &Path) -> Option<PathBuf> {
    (config_dir == data_dir).then(|| config_dir.to_path_buf())
}

fn new_layout_present(root: &Path) -> bool {
    let data = root.join(DATA_DIR_NAME);
    data.join(DB_FILE_NAME).exists()
        || data.join(DATA_FILE_NAME).exists()
        || root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME).exists()
}

fn legacy_layout_present(root: &Path) -> bool {
    root.join(DB_FILE_NAME).exists()
        || root.join(DATA_FILE_NAME).exists()
        || root.join(CONFIG_FILE_NAME).exists()
        || root.join(LEGACY_CONFIG_JSON_FILE_NAME).exists()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Classification {
    Settled,

    Empty,

    Unfinished,
}

fn classify(root: &Path) -> Classification {
    if root.join(JOURNAL_FILE_NAME).exists() {
        return Classification::Unfinished;
    }
    match (new_layout_present(root), legacy_layout_present(root)) {
        (true, false) => Classification::Settled,
        (false, false) => Classification::Empty,
        _ => Classification::Unfinished,
    }
}

fn sync_dir(path: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = File::open(path) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn write_journal(root: &Path, planned: &[(&'static str, Destination)]) -> Result<(), String> {
    let entries: Vec<_> = planned
        .iter()
        .map(|(name, destination)| {
            serde_json::json!({ "from": name, "to": format!("{}/{name}", destination.dir_name()) })
        })
        .collect();
    let body = serde_json::json!({ "version": 1, "moves": entries }).to_string();

    let temp_path = root.join(JOURNAL_TEMP_FILE_NAME);
    let mut file = File::create(&temp_path).map_err(|error| error.to_string())?;
    file.write_all(body.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);

    fs::rename(&temp_path, root.join(JOURNAL_FILE_NAME)).map_err(|error| error.to_string())?;
    sync_dir(root);
    Ok(())
}

fn clear_journal(root: &Path) {
    sync_dir(&root.join(CONFIG_DIR_NAME));
    sync_dir(&root.join(DATA_DIR_NAME));
    sync_dir(root);
    let _ = fs::remove_file(root.join(JOURNAL_FILE_NAME));
    sync_dir(root);
}

struct MigrationLock {
    path: PathBuf,

    waited_for_holder: bool,
}

impl MigrationLock {
    fn acquire(root: &Path) -> Option<Self> {
        let path = root.join(LOCK_FILE_NAME);
        let started = Instant::now();
        let mut waited_for_holder = false;
        let mut delete_pending_seen = false;
        loop {
            match Self::create(&path) {
                Ok(()) => {
                    return Some(Self {
                        path,
                        waited_for_holder,
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}

                Err(error) if cfg!(windows) && error.kind() == io::ErrorKind::PermissionDenied => {
                    if !delete_pending_seen {
                        delete_pending_seen = true;
                        log::info!(
                            "Storage layout lock was being released; waiting \
                             extra.releaseCheck=v1.3.3/layout-lock-delete-pending"
                        );
                    }
                }
                Err(error) => {
                    log::warn!("Failed to take the storage layout migration lock: {error}");
                    return None;
                }
            }
            if started.elapsed() >= LOCK_WAIT_TIMEOUT {
                return None;
            }
            if Self::is_stale(&path) {
                if fs::remove_file(&path).is_ok() {
                    continue;
                }
            } else {
                waited_for_holder = true;
            }
            thread::sleep(LOCK_WAIT_POLL);
        }
    }

    fn create(path: &Path) -> io::Result<()> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(|_| ())
    }

    fn is_stale(path: &Path) -> bool {
        fs::metadata(path)
            .and_then(|meta| meta.modified())
            .map(|modified| {
                modified
                    .elapsed()
                    .map(|age| age > LOCK_STALE_AFTER)
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }
}

impl Drop for MigrationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub(crate) fn migrate_standard_layout(root: &Path) -> LayoutMigration {
    if let Err(error) = fs::create_dir_all(root) {
        log::warn!("Failed to create the profile folder: {error}");
        return LayoutMigration::failed("root");
    }

    if classify(root) == Classification::Settled {
        return LayoutMigration::settled(LayoutOutcome::Already, 0, 0);
    }

    let Some(lock) = MigrationLock::acquire(root) else {
        log::warn!("Gave up waiting for the storage layout migration lock");
        return LayoutMigration::failed("lock");
    };

    match classify(root) {
        Classification::Settled => return LayoutMigration::settled(LayoutOutcome::Already, 0, 0),
        Classification::Empty => {
            return match create_subfolders(root) {
                Ok(()) => {
                    sync_dir(root);
                    LayoutMigration::settled(LayoutOutcome::Fresh, 0, 0)
                }
                Err(error) => {
                    log::warn!("Failed to create the profile subfolders: {error}");
                    LayoutMigration::failed("subfolders")
                }
            };
        }
        Classification::Unfinished => {
            if lock.waited_for_holder && root.join(JOURNAL_FILE_NAME).exists() {
                log::warn!("Another process gave up on the storage layout migration");
                return LayoutMigration::failed("lock");
            }
        }
    }

    let planned: Vec<(&'static str, Destination)> = MIGRATED_ENTRIES
        .iter()
        .copied()
        .filter(|(name, _)| root.join(name).exists())
        .collect();
    if planned.is_empty() {
        clear_journal(root);
        return LayoutMigration::settled(LayoutOutcome::Already, 0, 0);
    }

    if let Err(error) = write_journal(root, &planned) {
        log::warn!("Failed to write the storage layout migration journal: {error}");
        return LayoutMigration::failed(JOURNAL_FILE_NAME);
    }
    if let Err(error) = create_subfolders(root) {
        log::warn!("Failed to create the profile subfolders: {error}");
        return LayoutMigration::failed("subfolders");
    }

    let mut moved = 0;
    let mut kept = 0;

    let database_kept = root.join(DATA_DIR_NAME).join(DB_FILE_NAME).exists()
        || planned.iter().any(|(name, destination)| {
            is_database_entry(name) && root.join(destination.dir_name()).join(name).exists()
        });
    for (name, destination) in planned {
        let from = root.join(name);
        let to = root.join(destination.dir_name()).join(name);
        if database_kept && is_database_entry(name) {
            kept += 1;
            continue;
        }

        if to.exists() {
            kept += 1;
            continue;
        }
        match fs::rename(&from, &to) {
            Ok(()) => moved += 1,

            Err(_) if to.exists() && !from.exists() => kept += 1,
            Err(error) => {
                log::warn!("Failed to move {name} into the profile subfolders: {error}");
                roll_back(root);
                return LayoutMigration::failed(name);
            }
        }
    }

    clear_journal(root);
    LayoutMigration::settled(LayoutOutcome::Migrated, moved, kept)
}

fn create_subfolders(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join(CONFIG_DIR_NAME)).map_err(|error| error.to_string())?;
    fs::create_dir_all(root.join(DATA_DIR_NAME)).map_err(|error| error.to_string())
}

fn roll_back(root: &Path) {
    let database_stays =
        root.join(DB_FILE_NAME).exists() && root.join(DATA_DIR_NAME).join(DB_FILE_NAME).exists();
    for (name, destination) in MIGRATED_ENTRIES.iter().rev() {
        let from = root.join(destination.dir_name()).join(name);
        let to = root.join(name);
        if !from.exists() || to.exists() || (database_stays && is_database_entry(name)) {
            continue;
        }
        if let Err(error) = fs::rename(&from, &to) {
            log::warn!("Failed to restore {name} to the profile root: {error}");
        }
    }
    sync_dir(&root.join(CONFIG_DIR_NAME));
    sync_dir(&root.join(DATA_DIR_NAME));
    sync_dir(root);
}

static LAYOUT: OnceLock<LayoutMigration> = OnceLock::new();

pub(crate) fn standard_dirs(config_dir: PathBuf, data_dir: PathBuf) -> (PathBuf, PathBuf) {
    let Some(root) = standard_layout_root(&config_dir, &data_dir) else {
        return (config_dir, data_dir);
    };
    if LAYOUT
        .get_or_init(|| migrate_standard_layout(&root))
        .subfolders
    {
        return (root.join(CONFIG_DIR_NAME), root.join(DATA_DIR_NAME));
    }
    (config_dir, data_dir)
}

pub(crate) fn log_layout_migration() {
    let Some(migration) = LAYOUT.get() else {
        return;
    };
    let outcome = migration.outcome.as_str();
    let moved = migration.moved;
    let kept = migration.kept;
    match migration.failed_entry {
        Some(entry) => log::info!(
            "Storage layout migrated to profile subfolders \
             extra.releaseCheck=v1.3.2/standard-layout-subfolders \
             moved={moved} kept={kept} outcome={outcome} entry={entry}"
        ),
        None => log::info!(
            "Storage layout migrated to profile subfolders \
             extra.releaseCheck=v1.3.2/standard-layout-subfolders \
             moved={moved} kept={kept} outcome={outcome}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent dir");
        }
        fs::write(path, body).expect("write file");
    }

    fn legacy_profile(root: &Path) {
        write(&root.join(CONFIG_FILE_NAME), "sync_path = \"/tmp\"\n");
        write(&root.join(SECRETS_FILE_NAME), "token = \"secret\"\n");
        write(&root.join(DB_FILE_NAME), "db");
        write(&root.join("mindwtr.db-wal"), "wal");
        write(&root.join("mindwtr.db-shm"), "shm");
        write(&root.join(DATA_FILE_NAME), "{\"tasks\":[]}");
        write(&root.join("attachments").join("x.png"), "png");
        write(&root.join("notes-from-the-user.txt"), "not ours");
    }

    #[test]
    fn equal_os_dirs_share_one_root_and_distinct_ones_do_not() {
        assert_eq!(
            standard_layout_root(Path::new("/roaming/mindwtr"), Path::new("/roaming/mindwtr")),
            Some(PathBuf::from("/roaming/mindwtr"))
        );

        assert_eq!(
            standard_layout_root(
                Path::new("/home/a/.config/mindwtr"),
                Path::new("/home/a/.local/share/mindwtr")
            ),
            None
        );
    }

    #[test]
    fn a_flat_profile_moves_into_the_subfolders_once() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        legacy_profile(root);

        let first = migrate_standard_layout(root);
        assert_eq!(first.outcome, LayoutOutcome::Migrated);
        assert_eq!(first.moved, 7);
        assert_eq!(first.kept, 0);
        assert!(first.subfolders);

        for name in [CONFIG_FILE_NAME, SECRETS_FILE_NAME] {
            assert!(root.join(CONFIG_DIR_NAME).join(name).is_file());
            assert!(!root.join(name).exists());
        }
        for name in [
            DB_FILE_NAME,
            "mindwtr.db-wal",
            "mindwtr.db-shm",
            DATA_FILE_NAME,
        ] {
            assert!(root.join(DATA_DIR_NAME).join(name).is_file());
            assert!(!root.join(name).exists());
        }
        assert_eq!(
            fs::read_to_string(root.join(DATA_DIR_NAME).join("attachments").join("x.png"))
                .expect("attachment"),
            "png"
        );

        assert!(root.join("notes-from-the-user.txt").is_file());
        assert!(!root.join(JOURNAL_FILE_NAME).exists());
        assert!(!root.join(LOCK_FILE_NAME).exists(), "lock is released");

        let second = migrate_standard_layout(root);
        assert_eq!(second.outcome, LayoutOutcome::Already);
        assert_eq!(second.moved, 0);
        assert!(second.subfolders);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_move_keeps_the_flat_profile_whole_and_retries_next_start() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        legacy_profile(root);

        create_subfolders(root).expect("subfolders");
        let data = root.join(DATA_DIR_NAME);
        fs::set_permissions(&data, fs::Permissions::from_mode(0o500)).expect("lock data dir");

        let failed = migrate_standard_layout(root);
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).expect("unlock data dir");

        assert_eq!(failed.outcome, LayoutOutcome::Failed);
        assert_eq!(failed.failed_entry, Some("attachments"));
        assert!(!failed.subfolders, "the flat root stays authoritative");
        assert!(root.join(JOURNAL_FILE_NAME).is_file(), "journal is kept");
        assert!(!root.join(LOCK_FILE_NAME).exists(), "lock is released");

        for name in [
            CONFIG_FILE_NAME,
            SECRETS_FILE_NAME,
            DB_FILE_NAME,
            "mindwtr.db-wal",
            "mindwtr.db-shm",
            DATA_FILE_NAME,
        ] {
            assert!(root.join(name).is_file(), "{name} stayed at the root");
        }
        assert!(root.join("attachments").join("x.png").is_file());

        let retried = migrate_standard_layout(root);
        assert_eq!(retried.outcome, LayoutOutcome::Migrated);
        assert!(retried.subfolders);
        assert!(root.join(DATA_DIR_NAME).join(DB_FILE_NAME).is_file());
        assert!(!root.join(JOURNAL_FILE_NAME).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_failure_rolls_back_moves_an_earlier_crashed_run_made() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        legacy_profile(root);
        create_subfolders(root).expect("subfolders");

        fs::rename(
            root.join(CONFIG_FILE_NAME),
            root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME),
        )
        .expect("earlier move");
        write(
            &root.join(JOURNAL_FILE_NAME),
            "{\"version\":1,\"moves\":[]}",
        );

        let data = root.join(DATA_DIR_NAME);
        fs::set_permissions(&data, fs::Permissions::from_mode(0o500)).expect("lock data dir");
        let failed = migrate_standard_layout(root);
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).expect("unlock data dir");

        assert_eq!(failed.outcome, LayoutOutcome::Failed);
        assert!(!failed.subfolders);
        assert!(
            root.join(CONFIG_FILE_NAME).is_file(),
            "the earlier run's move is undone so the flat root is whole"
        );
        assert!(!root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME).exists());
        assert!(root.join(JOURNAL_FILE_NAME).is_file());
    }

    #[test]
    fn a_second_process_waits_for_a_fresh_lock_and_uses_the_settled_layout() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().to_path_buf();
        legacy_profile(&root);
        write(&root.join(LOCK_FILE_NAME), "");

        let holder_root = root.clone();
        let holder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            create_subfolders(&holder_root).expect("subfolders");
            for (name, destination) in MIGRATED_ENTRIES {
                let from = holder_root.join(name);
                if from.exists() {
                    fs::rename(&from, holder_root.join(destination.dir_name()).join(name))
                        .expect("holder move");
                }
            }
            fs::remove_file(holder_root.join(LOCK_FILE_NAME)).expect("release lock");
        });

        let waited = migrate_standard_layout(&root);
        holder.join().expect("holder thread");

        assert_eq!(waited.outcome, LayoutOutcome::Already);
        assert!(waited.subfolders, "the waiter reads the settled subfolders");
        assert_eq!(waited.moved, 0);
        assert_eq!(waited.failed_entry, None);
        assert!(root.join(DATA_DIR_NAME).join(DB_FILE_NAME).is_file());
        assert!(!root.join(DB_FILE_NAME).exists());
        assert!(!root.join(LOCK_FILE_NAME).exists(), "lock is released");
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_lock_that_cannot_be_removed_is_waited_out() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::SystemTime;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        legacy_profile(root);
        let lock = root.join(LOCK_FILE_NAME);
        write(&lock, "");
        File::options()
            .write(true)
            .open(&lock)
            .expect("lock handle")
            .set_modified(SystemTime::now() - LOCK_STALE_AFTER * 2)
            .expect("age the lock");

        fs::set_permissions(root, fs::Permissions::from_mode(0o500)).expect("lock root");

        let started = Instant::now();
        let blocked = migrate_standard_layout(root);
        let waited = started.elapsed();
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).expect("unlock root");

        assert_eq!(blocked.outcome, LayoutOutcome::Failed);
        assert_eq!(blocked.failed_entry, Some("lock"));
        assert!(
            waited >= LOCK_WAIT_TIMEOUT,
            "the whole wait was used, not {waited:?}"
        );
        assert!(lock.is_file(), "the other waiter's lock is left alone");
        assert!(root.join(DB_FILE_NAME).is_file(), "nothing was moved");
    }

    #[test]
    fn a_waiter_uses_the_subfolders_when_the_holder_succeeded() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().to_path_buf();

        write(&root.join(DATA_DIR_NAME).join(DB_FILE_NAME), "real db");
        write(
            &root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME),
            "sync_path = \"/original\"\n",
        );
        write(&root.join(DB_FILE_NAME), "leftover db");
        write(&root.join(CONFIG_FILE_NAME), "sync_path = \"/leftover\"\n");
        write(&root.join(LOCK_FILE_NAME), "");

        let holder_root = root.clone();
        let holder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            fs::remove_file(holder_root.join(LOCK_FILE_NAME)).expect("release lock");
        });

        let waited = migrate_standard_layout(&root);
        holder.join().expect("holder thread");

        assert_eq!(waited.outcome, LayoutOutcome::Migrated);
        assert!(
            waited.subfolders,
            "the waiter reads the same profile as the holder"
        );
        assert_eq!(waited.kept, 2);
        assert_eq!(waited.moved, 0);

        assert!(root.join(DB_FILE_NAME).is_file());
        assert_eq!(
            fs::read_to_string(root.join(DATA_DIR_NAME).join(DB_FILE_NAME)).expect("db"),
            "real db"
        );
        assert_eq!(
            fs::read_to_string(root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME)).expect("config"),
            "sync_path = \"/original\"\n"
        );
    }

    #[test]
    fn a_waiter_stays_flat_when_the_holder_gave_up() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().to_path_buf();
        legacy_profile(&root);
        write(&root.join(LOCK_FILE_NAME), "");
        write(
            &root.join(JOURNAL_FILE_NAME),
            "{\"version\":1,\"moves\":[]}",
        );

        let holder_root = root.clone();
        let holder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            fs::remove_file(holder_root.join(LOCK_FILE_NAME)).expect("release lock");
        });

        let waited = migrate_standard_layout(&root);
        holder.join().expect("holder thread");

        assert_eq!(waited.outcome, LayoutOutcome::Failed);
        assert_eq!(waited.failed_entry, Some("lock"));
        assert!(!waited.subfolders, "both processes read the flat root");
        assert!(root.join(DB_FILE_NAME).is_file(), "nothing was moved");
        assert!(!root.join(DATA_DIR_NAME).join(DB_FILE_NAME).exists());
        assert!(
            root.join(JOURNAL_FILE_NAME).is_file(),
            "the journal makes the next start retry"
        );
        assert!(!root.join(LOCK_FILE_NAME).exists(), "lock is released");
    }

    #[test]
    fn a_lock_held_by_another_process_leaves_the_flat_root_alone() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        legacy_profile(root);
        write(&root.join(LOCK_FILE_NAME), "");

        let blocked = migrate_standard_layout(root);
        assert_eq!(blocked.outcome, LayoutOutcome::Failed);
        assert_eq!(blocked.failed_entry, Some("lock"));
        assert!(!blocked.subfolders);
        assert!(root.join(DB_FILE_NAME).is_file(), "nothing was moved");
        assert!(!root.join(JOURNAL_FILE_NAME).exists());
        assert!(
            root.join(LOCK_FILE_NAME).is_file(),
            "the holder's lock is not stolen"
        );

        fs::remove_file(root.join(LOCK_FILE_NAME)).expect("release lock");
        assert_eq!(
            migrate_standard_layout(root).outcome,
            LayoutOutcome::Migrated
        );
    }

    #[test]
    fn markers_at_both_ends_without_a_journal_resume_the_migration() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        legacy_profile(root);
        create_subfolders(root).expect("subfolders");
        fs::rename(
            root.join(CONFIG_FILE_NAME),
            root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME),
        )
        .expect("survived rename");

        assert_eq!(classify(root), Classification::Unfinished);
        let resumed = migrate_standard_layout(root);
        assert_eq!(resumed.outcome, LayoutOutcome::Migrated);
        assert!(resumed.subfolders);
        assert!(root.join(DATA_DIR_NAME).join(DB_FILE_NAME).is_file());
        assert!(root.join(DATA_DIR_NAME).join(DATA_FILE_NAME).is_file());
    }

    #[test]
    fn a_config_json_only_profile_is_migrated_not_treated_as_fresh() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        write(
            &root.join(LEGACY_CONFIG_JSON_FILE_NAME),
            "{\"dataFilePath\":\"/elsewhere/data.json\"}",
        );

        assert_eq!(classify(root), Classification::Unfinished);
        let migrated = migrate_standard_layout(root);
        assert_eq!(migrated.outcome, LayoutOutcome::Migrated);
        assert_eq!(migrated.moved, 1);
        assert!(root
            .join(CONFIG_DIR_NAME)
            .join(LEGACY_CONFIG_JSON_FILE_NAME)
            .is_file());
        assert!(!root.join(LEGACY_CONFIG_JSON_FILE_NAME).exists());
    }

    #[test]
    fn an_entry_present_at_both_ends_keeps_the_moved_original() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();

        legacy_profile(root);
        write(
            &root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME),
            "sync_path = \"/original\"\n",
        );
        write(
            &root.join(JOURNAL_FILE_NAME),
            "{\"version\":1,\"moves\":[]}",
        );

        let resumed = migrate_standard_layout(root);
        assert_eq!(resumed.outcome, LayoutOutcome::Migrated);
        assert_eq!(resumed.kept, 1);

        assert_eq!(
            fs::read_to_string(root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME)).expect("config"),
            "sync_path = \"/original\"\n"
        );
        assert!(root.join(CONFIG_FILE_NAME).is_file());
    }

    #[test]
    fn a_root_database_sidecar_never_joins_the_migrated_database() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();

        write(&root.join(DATA_DIR_NAME).join(DB_FILE_NAME), "real db");
        write(
            &root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME),
            "sync_path = \"/original\"\n",
        );

        write(&root.join(DB_FILE_NAME), "flat db");
        write(&root.join("mindwtr.db-wal"), "flat wal");

        let resumed = migrate_standard_layout(root);
        assert_eq!(resumed.outcome, LayoutOutcome::Migrated);
        assert!(resumed.subfolders);
        assert_eq!(resumed.moved, 0);
        assert_eq!(
            resumed.kept, 2,
            "the database and its WAL are kept as one unit"
        );
        assert!(
            !root.join(DATA_DIR_NAME).join("mindwtr.db-wal").exists(),
            "the flat session's WAL never lands next to the real database"
        );
        assert!(root.join("mindwtr.db-wal").is_file());
        assert!(root.join(DB_FILE_NAME).is_file());
        assert_eq!(
            fs::read_to_string(root.join(DATA_DIR_NAME).join(DB_FILE_NAME)).expect("db"),
            "real db"
        );
    }

    #[test]
    fn a_stale_sidecar_in_data_keeps_the_root_database_at_the_root() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        write(&root.join(DB_FILE_NAME), "root db");
        write(&root.join("mindwtr.db-wal"), "live wal");
        write(
            &root.join(DATA_DIR_NAME).join("mindwtr.db-wal"),
            "stale wal",
        );
        write(
            &root.join(JOURNAL_FILE_NAME),
            "{\"version\":1,\"moves\":[]}",
        );

        let resumed = migrate_standard_layout(root);
        assert_eq!(resumed.outcome, LayoutOutcome::Migrated);
        assert_eq!(resumed.moved, 0);
        assert_eq!(resumed.kept, 2, "the database and its WAL are one unit");
        assert!(
            !root.join(DATA_DIR_NAME).join(DB_FILE_NAME).exists(),
            "the database never lands next to a stale WAL"
        );
        assert_eq!(
            fs::read_to_string(root.join("mindwtr.db-wal")).expect("wal"),
            "live wal"
        );
        assert!(root.join(DB_FILE_NAME).is_file());
    }

    #[test]
    fn a_database_still_follows_its_own_sidecars_into_data() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        write(&root.join(DB_FILE_NAME), "db");
        write(&root.join(DATA_DIR_NAME).join("mindwtr.db-wal"), "wal");
        write(&root.join(DATA_DIR_NAME).join("mindwtr.db-shm"), "shm");
        write(
            &root.join(JOURNAL_FILE_NAME),
            "{\"version\":1,\"moves\":[]}",
        );

        let resumed = migrate_standard_layout(root);
        assert_eq!(resumed.outcome, LayoutOutcome::Migrated);
        assert_eq!(resumed.moved, 1);
        assert!(root.join(DATA_DIR_NAME).join(DB_FILE_NAME).is_file());
        assert!(!root.join(DB_FILE_NAME).exists());
    }

    #[test]
    fn a_rollback_restores_the_sidecars_of_a_database_that_never_moved() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();

        write(&root.join(DB_FILE_NAME), "root db");
        write(&root.join(DATA_DIR_NAME).join("mindwtr.db-wal"), "root wal");
        write(&root.join(DATA_DIR_NAME).join("mindwtr.db-shm"), "root shm");
        write(
            &root.join(DATA_DIR_NAME).join("attachments").join("x.png"),
            "png",
        );
        write(
            &root.join(JOURNAL_FILE_NAME),
            "{\"version\":1,\"moves\":[]}",
        );

        roll_back(root);

        assert_eq!(
            fs::read_to_string(root.join("mindwtr.db-wal")).expect("wal"),
            "root wal",
            "the database's own WAL comes back with it"
        );
        assert!(!root.join(DATA_DIR_NAME).join("mindwtr.db-wal").exists());
        assert!(root.join("mindwtr.db-shm").is_file());
        assert!(!root.join(DATA_DIR_NAME).join("mindwtr.db-shm").exists());
        assert!(root.join("attachments").join("x.png").is_file());
        assert_eq!(
            fs::read_to_string(root.join(DB_FILE_NAME)).expect("db"),
            "root db"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_rollback_never_puts_a_sidecar_next_to_a_different_root_database() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();

        write(&root.join(DATA_DIR_NAME).join(DB_FILE_NAME), "real db");
        write(&root.join(DATA_DIR_NAME).join("mindwtr.db-wal"), "real wal");
        write(&root.join(DB_FILE_NAME), "downgrade db");
        write(&root.join(CONFIG_FILE_NAME), "sync_path = \"/tmp\"\n");
        write(&root.join(SECRETS_FILE_NAME), "token = \"secret\"\n");
        write(&root.join("attachments").join("x.png"), "png");

        create_subfolders(root).expect("subfolders");
        let config = root.join(CONFIG_DIR_NAME);
        fs::set_permissions(&config, fs::Permissions::from_mode(0o500)).expect("lock config dir");
        let failed = migrate_standard_layout(root);
        fs::set_permissions(&config, fs::Permissions::from_mode(0o700)).expect("unlock config dir");

        assert_eq!(failed.outcome, LayoutOutcome::Failed);
        assert_eq!(failed.failed_entry, Some(SECRETS_FILE_NAME));
        assert!(!failed.subfolders, "the flat root stays authoritative");
        assert!(
            !root.join("mindwtr.db-wal").exists(),
            "the migrated database's WAL is not restored next to another database"
        );
        assert_eq!(
            fs::read_to_string(root.join(DATA_DIR_NAME).join("mindwtr.db-wal")).expect("wal"),
            "real wal"
        );
        assert_eq!(
            fs::read_to_string(root.join(DB_FILE_NAME)).expect("db"),
            "downgrade db"
        );

        assert!(root.join("attachments").join("x.png").is_file());
    }

    #[test]
    fn a_fresh_profile_starts_in_the_new_layout() {
        let temp = tempfile::tempdir().expect("temp dir");

        let root = &temp.path().join("mindwtr");

        let fresh = migrate_standard_layout(root);
        assert_eq!(fresh.outcome, LayoutOutcome::Fresh);
        assert_eq!(fresh.moved, 0);
        assert!(fresh.subfolders);
        assert!(root.join(CONFIG_DIR_NAME).is_dir());
        assert!(root.join(DATA_DIR_NAME).is_dir());
        assert!(!root.join(JOURNAL_FILE_NAME).exists());
        assert!(!root.join(LOCK_FILE_NAME).exists());
    }

    #[test]
    fn a_profile_already_in_the_new_layout_is_left_alone() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        write(&root.join(DATA_DIR_NAME).join(DB_FILE_NAME), "db");
        write(&root.join("notes-from-the-user.txt"), "not ours");

        let already = migrate_standard_layout(root);
        assert_eq!(already.outcome, LayoutOutcome::Already);
        assert!(already.subfolders);
        assert!(root.join("notes-from-the-user.txt").is_file());
        assert!(!root.join(LOCK_FILE_NAME).exists(), "no lock was taken");
    }
}
