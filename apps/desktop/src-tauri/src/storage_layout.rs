//! Standard (installed) profile layout.
//!
//! Windows and macOS resolve the app's OS config dir and data dir to the same
//! folder (`%APPDATA%\mindwtr`, `~/Library/Application Support/mindwtr`), so an
//! installed build used to pile config files and data files side by side there
//! while the portable build kept `profile/config/` and `profile/data/` apart
//! (#1245). This module gives those installs the same two subfolders, and
//! migrates an older flat folder once, before the first config or database
//! read. On Linux the two OS dirs are already distinct and nothing changes.
//!
//! The migration is a journaled, same-volume `fs::rename` of a fixed list of
//! entries the app itself writes. It never touches anything else in the folder
//! and never deletes a file. A downgrade is not supported: an older build looks
//! only at the flat root.
//!
//! Three things keep a half-finished run from ever being read as a whole
//! profile:
//!
//! * A lock file makes one process at a time mutate the folder. The migration
//!   runs inside the path lookup, which happens before the single-instance
//!   plugin exists, so it cannot lean on that plugin. A second process waits a
//!   few seconds for the holder and then re-reads the folder, because either
//!   process may be the one the single-instance plugin keeps — and if the
//!   holder gave up, the waiter gives up too rather than move the folder under
//!   a process that has settled on the flat root.
//! * The journal is published atomically and synced before the first rename,
//!   and removed only after every rename is durable, so a power loss is always
//!   visible to the next start.
//! * A failure rolls the whole folder back to the flat layout — including
//!   moves an earlier crashed run made — and that run keeps reading the flat
//!   root. The journal is left in place for the next start to finish.

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
/// A migration is a handful of same-volume renames. A lock file older than this
/// is a crash leftover, not a run in progress.
const LOCK_STALE_AFTER: Duration = Duration::from_secs(120);
/// How long a second process waits for the holder's migration before giving up
/// and reading the flat root for this start. A migration is a handful of
/// same-volume renames, and this wait happens at process start, before the
/// window exists, so it stays short.
const LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(3);
const LOCK_WAIT_POLL: Duration = Duration::from_millis(50);
/// The pre-TOML settings file. Also a legacy marker: a profile holding only
/// this one still has settings to import, including a custom data file path.
const LEGACY_CONFIG_JSON_FILE_NAME: &str = "config.json";
/// The recovery copy of `data.json`. Evidence of a real profile even when the
/// live files are missing.
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

/// Every entry the app itself writes to the profile root, and the subfolder it
/// belongs in. Anything absent from this list is left at the root untouched —
/// the folder may well hold files no version of Mindwtr wrote.
///
/// Order matters. The files that mark a profile as migrated (`config.toml`,
/// `data.json`, `mindwtr.db`) move last, and the database moves after its own
/// `-wal`/`-shm`/`-journal` sidecars. Together with the family rules in
/// `migrate_standard_layout` and `roll_back`, that keeps the database and those
/// sidecars in one folder whether a run finishes, fails or is resumed.
///
/// This list is also how a crashed run is undone: an entry sitting at its
/// destination while its root name is free was put there by a migration, so a
/// failure can put every one of them back without replaying a log.
const MIGRATED_ENTRIES: &[(&str, Destination)] = &[
    // --- data ---
    ("attachments", Data),    // platform.rs, attachment_installer.rs
    ("audio-captures", Data), // audio.rs
    ("logs", Data),           // logging.rs
    ("snapshots", Data),      // storage.rs recovery snapshots
    ("whisper-models", Data), // audio.rs WHISPER_INSTALL_DIR_NAME
    ("parakeet-model", Data), // audio.rs PARAKEET_INSTALL_DIR_NAME
    ("sherpa-onnx", Data),    // audio.rs SHERPA_INSTALL_DIR_NAME
    ("file-sync-attachment-publications-v2", Data), // file_sync_attachment_publication.rs
    ("email-capture-state.json", Data), // email_capture.rs
    (DATA_JSON_BACKUP_FILE_NAME, Data), // storage.rs data_json_backup_path
    // --- config ---
    (SECRETS_FILE_NAME, Config),
    ("config-credential-state.json", Config), // config.rs
    (SYNC_BACKEND_STATE_FILE_NAME, Config),
    (LEGACY_SYNC_BACKEND_STATE_FILE_NAME, Config),
    (".config.toml.mindwtr-rollback", Config), // config.rs config_rollback_path
    (".secrets.toml.mindwtr-rollback", Config),
    (LEGACY_CONFIG_JSON_FILE_NAME, Config),
    ("window-layouts.json", Config), // window_state.rs
    ("window-state.json", Config),   // window-state plugin file the app still reads
    // --- markers, last ---
    (CONFIG_FILE_NAME, Config),
    (DATA_FILE_NAME, Data),
    ("mindwtr.db-wal", Data),
    ("mindwtr.db-shm", Data),
    ("mindwtr.db-journal", Data),
    (DB_FILE_NAME, Data),
];

/// Every name in `MIGRATED_ENTRIES`, for the workspace classification test
/// (#1473): a new entry must say whether it is device-level or per-workspace.
#[cfg(test)]
pub(crate) fn migrated_entry_names() -> impl Iterator<Item = &'static str> {
    MIGRATED_ENTRIES.iter().map(|(name, _)| *name)
}

/// `mindwtr.db` and its `-wal`/`-shm`/`-journal` sidecars are one unit. SQLite
/// replays a WAL that passes its own checksums without checking which database
/// wrote it, so a sidecar next to a different database can corrupt it. Whichever
/// side already holds the database keeps the sidecars there: none of the family
/// crosses on its own.
fn is_database_entry(name: &str) -> bool {
    name.starts_with(DB_FILE_NAME)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LayoutOutcome {
    /// The profile already used the subfolders.
    Already,
    /// Nothing was there yet; the subfolders were created.
    Fresh,
    /// A flat profile was moved into the subfolders.
    Migrated,
    /// A move failed, or another process held the lock. The flat root stays
    /// authoritative for this run.
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
    /// Entries moved by this run.
    pub(crate) moved: usize,
    /// Entries found at both ends, where the already-moved copy was kept and
    /// the root leftover left alone.
    pub(crate) kept: usize,
    /// What went wrong. Always a fixed internal name, never a user path.
    pub(crate) failed_entry: Option<&'static str>,
    /// Whether this process reads and writes the subfolders. False after a
    /// failed migration, so a half-moved profile is never read from two places.
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

    /// A failed run always ends with every entry back at the root, so nothing
    /// counts as moved.
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

/// The one folder a standard install uses when the OS resolves the app's config
/// dir and data dir to the same place (Windows Roaming, macOS Application
/// Support). `None` on Linux, where XDG already keeps them apart.
pub(crate) fn standard_layout_root(config_dir: &Path, data_dir: &Path) -> Option<PathBuf> {
    (config_dir == data_dir).then(|| config_dir.to_path_buf())
}

fn new_layout_present(root: &Path) -> bool {
    let data = root.join(DATA_DIR_NAME);
    data.join(DB_FILE_NAME).exists()
        || data.join(DATA_FILE_NAME).exists()
        || root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME).exists()
}

/// `config.json` counts: a pre-TOML profile holding nothing else still has
/// settings to import, and its `data_file_path` may be the only pointer to the
/// user's data.
fn legacy_layout_present(root: &Path) -> bool {
    root.join(DB_FILE_NAME).exists()
        || root.join(DATA_FILE_NAME).exists()
        || root.join(CONFIG_FILE_NAME).exists()
        || root.join(LEGACY_CONFIG_JSON_FILE_NAME).exists()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Classification {
    /// Fully in the subfolders, with nothing left at the root.
    Settled,
    /// Nothing here yet.
    Empty,
    /// A flat profile, or one an interrupted run left half moved.
    Unfinished,
}

/// Reads the folder and decides what has to happen. Markers at both ends, or a
/// journal, mean an earlier run stopped partway: never treat that as settled,
/// or the still-flat database would be ignored and a new empty one created.
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

/// Makes the directory's own entry list durable, so a rename or a removal
/// survives a power loss. Windows cannot open a directory as a file, and its
/// rename metadata is ordered by the file system, so the call is Unix-only.
fn sync_dir(path: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = File::open(path) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Publishes the journal atomically: a synced temp file renamed into place,
/// then the root directory synced. Until this returns the folder is untouched.
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

/// Removes the journal only once every rename is on disk, so the journal's
/// absence always means the move really finished.
fn clear_journal(root: &Path) {
    sync_dir(&root.join(CONFIG_DIR_NAME));
    sync_dir(&root.join(DATA_DIR_NAME));
    sync_dir(root);
    let _ = fs::remove_file(root.join(JOURNAL_FILE_NAME));
    sync_dir(root);
}

/// One migration at a time across processes. The path lookup that triggers the
/// migration runs before the single-instance plugin is initialized, so two
/// simultaneous launches would otherwise interleave renames.
struct MigrationLock {
    path: PathBuf,
    /// Whether another process held a live lock that this one waited out. A
    /// stale lock replaced after a crash does not count: nobody was running.
    waited_for_holder: bool,
}

impl MigrationLock {
    /// Waits out another process's migration rather than spending the whole
    /// session on the flat root: the caller re-reads the folder under the lock,
    /// so a waiter ends up on the same layout as the holder. The wait is bounded
    /// because this runs on the first path lookup at process start.
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
                // Windows: a lock file the holder is deleting while another handle is open
                // (our own is_stale metadata read, or antivirus) is "delete pending", and
                // creating it again fails with access denied until the last handle closes.
                // That is the holder releasing, not an I/O failure: keep waiting.
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
                // A crashed run left this behind. Replacing it is safe: no
                // migration takes minutes. A removal that fails means another
                // waiter is clearing the same lock — contention, not an I/O
                // failure — and that one may be about to migrate the folder, so
                // look again instead of settling for the flat root.
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

/// Moves a flat standard profile into `config/` and `data/`, or reports why it
/// did not. Safe to call again after any outcome.
pub(crate) fn migrate_standard_layout(root: &Path) -> LayoutMigration {
    // A brand-new install has no profile folder yet, and the lock file below
    // needs one to be created in.
    if let Err(error) = fs::create_dir_all(root) {
        log::warn!("Failed to create the profile folder: {error}");
        return LayoutMigration::failed("root");
    }
    // The settled case is every start after the first, and it changes nothing,
    // so it never contends for the lock.
    if classify(root) == Classification::Settled {
        return LayoutMigration::settled(LayoutOutcome::Already, 0, 0);
    }

    let Some(lock) = MigrationLock::acquire(root) else {
        // The holder outlasted the wait, or the lock file itself could not be
        // written. Reading the flat root is the safe answer: it is where the
        // files still are, or were a moment ago.
        log::warn!("Gave up waiting for the storage layout migration lock");
        return LayoutMigration::failed("lock");
    };

    // Re-read under the lock: the holder may have finished in between.
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
            // A holder was running and left its journal behind, so its run
            // failed and rolled back: every run that succeeds clears the
            // journal, and leftovers kept on purpose at both ends make even a
            // successful folder read as unfinished. The failed holder is already
            // reading the flat root and may be the instance the single-instance
            // plugin keeps; migrating now would empty the root under it. Both
            // stay flat and the journal makes the next start retry.
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

    // Durable before the first rename, so a power loss always leaves the next
    // start a reason to resume instead of trusting the markers.
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
    // The family moves whole or not at all: a root entry left behind while the
    // rest moves would pair a stale sidecar with a live database. It stays at
    // the root when data/ already holds a database, and when any root family
    // entry has a destination that is taken — that entry cannot move, so none of
    // them may. Read before the first rename: the state the run started from
    // decides for the whole family.
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
        // Both ends hold it: an earlier run moved the original and a later flat
        // run recreated the name at the root. The moved copy is the original
        // and wins; the leftover is left alone rather than deleted.
        if to.exists() {
            kept += 1;
            continue;
        }
        match fs::rename(&from, &to) {
            Ok(()) => moved += 1,
            // Another process moved it between the check and the rename.
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

/// Puts the whole folder back to the flat layout, so the run that falls back to
/// it reads a complete profile.
///
/// Every known entry sitting at its destination while its root name is free was
/// put there by a migration — the journal only exists mid-flight — so this also
/// undoes what an earlier crashed run moved, not just this run's work. The root
/// name was vacated moments ago and no connection is open yet, so each rename
/// has a free destination; a failure is logged by entry name and left for the
/// journal to finish on the next start.
fn roll_back(root: &Path) {
    // The same unit rule in the other direction, and only when both ends hold a
    // database: then each keeps the sidecars on its own side. With a database at
    // the root alone, the sidecars in data/ are that database's own — this run
    // moved them there moments ago — and they must come back with it, or the
    // falling-back run opens the database without its WAL.
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

/// The config dir and data dir this process uses. On Windows and macOS the
/// first call migrates a flat profile; it runs inside the path lookup itself,
/// which is what makes it provably earlier than any config or database read.
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

/// Reports the migration once the log plugin exists. The first config read
/// happens at the very top of `run()`, before any logger is installed, so the
/// line cannot be emitted where the work is done.
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
        // Windows and macOS.
        assert_eq!(
            standard_layout_root(Path::new("/roaming/mindwtr"), Path::new("/roaming/mindwtr")),
            Some(PathBuf::from("/roaming/mindwtr"))
        );
        // Linux: XDG already separates the two, so nothing moves.
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
        // Files the app never wrote stay exactly where the user left them.
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

        // A read-only destination makes every rename into data/ fail. The first
        // planned entry is attachments/, so the failure lands before any marker.
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
        // Every file is still readable where the running app expects it.
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

        // The next start finds the journal and finishes the job.
        let retried = migrate_standard_layout(root);
        assert_eq!(retried.outcome, LayoutOutcome::Migrated);
        assert!(retried.subfolders);
        assert!(root.join(DATA_DIR_NAME).join(DB_FILE_NAME).is_file());
        assert!(!root.join(JOURNAL_FILE_NAME).exists());
    }

    // Finding 1: a run that inherits a crashed run's half-moved folder and then
    // fails must put back that earlier run's moves too, or it would read a flat
    // root whose config.toml is still sitting under config/.
    #[cfg(unix)]
    #[test]
    fn a_failure_rolls_back_moves_an_earlier_crashed_run_made() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        legacy_profile(root);
        create_subfolders(root).expect("subfolders");

        // An earlier run moved config.toml and then crashed, leaving a journal.
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

    // Finding F4: a second launch waits for the holder instead of running its
    // whole session on the flat root. On Windows the loser of the lock race can
    // be the process the single-instance plugin keeps, so it has to end up on
    // the same layout as the holder.
    #[test]
    fn a_second_process_waits_for_a_fresh_lock_and_uses_the_settled_layout() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().to_path_buf();
        legacy_profile(&root);
        write(&root.join(LOCK_FILE_NAME), "");

        // The holder migrates the folder and releases the lock while the second
        // caller is still waiting.
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

    // Finding C4: a stale lock this process cannot remove means another waiter
    // is clearing it right now. That is contention, not an I/O failure, so the
    // wait runs its course instead of dropping to the flat root at once — the
    // other waiter may be about to migrate the folder.
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
        // A read-only profile folder fails every removal, the way losing the
        // race to another waiter does.
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

    // Finding N1: a folder with leftovers kept on purpose at both ends reads as
    // unfinished on every start, including after a run that fully succeeded. The
    // waiter must tell that apart from a holder that gave up, or it spends its
    // session on the root leftovers while the holder reads data/.
    #[test]
    fn a_waiter_uses_the_subfolders_when_the_holder_succeeded() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().to_path_buf();
        // What a downgrade leaves: the real profile in the subfolders, plus the
        // older build's own files at the root.
        write(&root.join(DATA_DIR_NAME).join(DB_FILE_NAME), "real db");
        write(
            &root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME),
            "sync_path = \"/original\"\n",
        );
        write(&root.join(DB_FILE_NAME), "leftover db");
        write(&root.join(CONFIG_FILE_NAME), "sync_path = \"/leftover\"\n");
        write(&root.join(LOCK_FILE_NAME), "");

        // The holder keeps both leftovers, clears its journal and releases.
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
        // The leftovers are still there, and the real profile is untouched.
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

    // Finding C3: a holder that releases the lock with the folder still
    // unfinished failed and rolled back. It is already reading the flat root, so
    // the waiter must not migrate the folder out from under it — both stay flat
    // and the journal makes the next start retry.
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

        // The holder tries, rolls back, and releases the lock unchanged.
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

    // Finding 2: the migration runs before the single-instance plugin exists,
    // so a second launch must not interleave renames with the first. A holder
    // that never finishes ends the wait at the timeout, on the flat root.
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

        // Once the holder is gone the next start migrates normally.
        fs::remove_file(root.join(LOCK_FILE_NAME)).expect("release lock");
        assert_eq!(
            migrate_standard_layout(root).outcome,
            LayoutOutcome::Migrated
        );
    }

    // Finding 3: a power loss can keep a rename and lose the journal. Markers
    // at both ends must resume, never report the profile as settled — that is
    // how a still-flat database gets ignored and an empty one created.
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

    // Finding 5: a pre-TOML profile may hold only config.json, whose
    // data_file_path can be the one pointer to the user's data.
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
        // A profile whose config.toml already sits in config/ from an earlier
        // failed run, plus a default one the flat run wrote afterwards.
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
        // The moved original wins; the root leftover is kept, not deleted.
        assert_eq!(
            fs::read_to_string(root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME)).expect("config"),
            "sync_path = \"/original\"\n"
        );
        assert!(root.join(CONFIG_FILE_NAME).is_file());
    }

    // Finding F5: the database and its sidecars are one unit. SQLite replays a
    // WAL that passes its own checksums without checking which database wrote
    // it, so a root WAL left by a killed flat session must never be moved next
    // to the migrated database.
    #[test]
    fn a_root_database_sidecar_never_joins_the_migrated_database() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        // The real profile, cleanly closed and already in the subfolders: a
        // clean close leaves no WAL behind.
        write(&root.join(DATA_DIR_NAME).join(DB_FILE_NAME), "real db");
        write(
            &root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME),
            "sync_path = \"/original\"\n",
        );
        // What a killed flat-root session left at the root.
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

    // Finding C1, forward direction: an earlier rollback that could not put the
    // WAL back leaves a stale copy in data/, and a flat session then wrote a new
    // one at the root. Moving the database in on its own would replay the stale
    // WAL over it, so the whole family stays at the root instead.
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

    // The boundary of that rule: when the sidecars in data/ are this database's
    // own, moved by a run that crashed before the database itself, the database
    // must still follow them in. Nothing else may keep it at the root.
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

    // Finding C1: the plain failed-run shape. The sidecars move before the
    // database, so a failure on the database itself leaves them in data/ while
    // the database is still at the root. They belong to that database and must
    // come back with it, or the falling-back run opens it without its WAL.
    #[test]
    fn a_rollback_restores_the_sidecars_of_a_database_that_never_moved() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        // What the forward loop leaves when the database rename fails: the
        // sidecars and the earlier entries are already in data/.
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

    // Finding F5, the same unit rule in reverse: a rollback must not put a
    // migrated database's WAL next to the different database sitting at the
    // root, which the falling-back run is about to open.
    #[cfg(unix)]
    #[test]
    fn a_rollback_never_puts_a_sidecar_next_to_a_different_root_database() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        // An earlier run moved the profile; a downgrade then ran on the flat
        // root and left its own database there, without a WAL.
        write(&root.join(DATA_DIR_NAME).join(DB_FILE_NAME), "real db");
        write(&root.join(DATA_DIR_NAME).join("mindwtr.db-wal"), "real wal");
        write(&root.join(DB_FILE_NAME), "downgrade db");
        write(&root.join(CONFIG_FILE_NAME), "sync_path = \"/tmp\"\n");
        write(&root.join(SECRETS_FILE_NAME), "token = \"secret\"\n");
        write(&root.join("attachments").join("x.png"), "png");

        // A read-only config/ fails the first Config entry, after the data
        // entries have moved, so the rollback runs with data/ writable.
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
        // Everything else the run touched is back at the root.
        assert!(root.join("attachments").join("x.png").is_file());
    }

    #[test]
    fn a_fresh_profile_starts_in_the_new_layout() {
        let temp = tempfile::tempdir().expect("temp dir");
        // A first install: the profile folder itself does not exist yet.
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
