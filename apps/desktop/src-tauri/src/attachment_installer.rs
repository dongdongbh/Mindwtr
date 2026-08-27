use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const INSTALL_JOURNAL_VERSION: u8 = 1;
const MAX_INSTALL_JOURNAL_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum AttachmentInstallExpectation {
    Absent,
    Present { sha256: String },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AttachmentInstallConflictReason {
    TargetExists,
    TargetMissing,
    GenerationMismatch,
    RecoveryConflict,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum AttachmentInstallOutcome {
    Installed,
    Conflict {
        reason: AttachmentInstallConflictReason,
        #[serde(rename = "preservedPath", skip_serializing_if = "Option::is_none")]
        preserved_path: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AttachmentInstallJournal {
    version: u8,
    staged_path: PathBuf,
    target_path: PathBuf,
    quarantine_path: Option<PathBuf>,
    staged_sha256: String,
    expected: AttachmentInstallExpectation,
}

enum RecoveryOutcome {
    None,
    Installed { sha256: String },
    Conflict { preserved_path: PathBuf },
}

fn conflict(
    reason: AttachmentInstallConflictReason,
    preserved_path: Option<&Path>,
) -> AttachmentInstallOutcome {
    AttachmentInstallOutcome::Conflict {
        reason,
        preserved_path: preserved_path.map(|path| path.to_string_lossy().into_owned()),
    }
}

fn normalize_sha256(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(
            "attachment install expected SHA-256 must be 64 hexadecimal characters".to_string(),
        );
    }
    Ok(normalized)
}

fn random_suffix() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn sha256_file(path: &Path) -> Result<String, String> {
    validate_regular_file(path, "hash source")?;
    let mut file = File::open(path).map_err(|error| {
        format!(
            "failed to open attachment install file {}: {error}",
            path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| {
            format!(
                "failed to hash attachment install file {}: {error}",
                path.display()
            )
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn path_is_lexically_normal(path: &Path) -> bool {
    path.is_absolute()
        && path.components().all(|component| {
            matches!(
                component,
                std::path::Component::Prefix(_)
                    | std::path::Component::RootDir
                    | std::path::Component::Normal(_)
            )
        })
}

fn validate_managed_root(root: &Path) -> Result<(), String> {
    if !path_is_lexically_normal(root) {
        return Err("attachment install root must be an absolute normalized path".to_string());
    }
    let metadata = fs::symlink_metadata(root).map_err(|error| {
        format!(
            "failed to inspect attachment install root {}: {error}",
            root.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("attachment install root must be a real directory, not a symlink".to_string());
    }
    Ok(())
}

fn validate_path_in_root(root: &Path, path: &Path, label: &str) -> Result<(), String> {
    if !path_is_lexically_normal(path) || path.parent() != Some(root) || path.file_name().is_none()
    {
        return Err(format!(
            "attachment install {label} must be a direct child of the managed attachments directory"
        ));
    }
    Ok(())
}

fn validate_regular_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "failed to inspect attachment install {label} {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("attachment install {label} must be a regular file"));
    }
    Ok(())
}

fn validate_optional_target(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("attachment install target must be absent or a regular file".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to inspect attachment install target: {error}"
        )),
    }
}

fn validate_install_paths(
    root: &Path,
    staged_path: &Path,
    target_path: &Path,
) -> Result<(), String> {
    validate_managed_root(root)?;
    validate_path_in_root(root, staged_path, "stage")?;
    validate_path_in_root(root, target_path, "target")?;
    if staged_path == target_path {
        return Err("attachment install stage and target must be different paths".to_string());
    }
    validate_regular_file(staged_path, "stage")?;
    validate_optional_target(target_path)
}

fn target_journal_path(root: &Path, target_path: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(target_path.to_string_lossy().as_bytes());
    root.join(format!(
        ".mindwtr-attachment-install-{:x}.json",
        hasher.finalize()
    ))
}

fn next_quarantine_path(root: &Path) -> Result<PathBuf, String> {
    for _ in 0..16 {
        let candidate = root.join(format!(".mindwtr-attachment-local-{}", random_suffix()));
        match candidate.try_exists() {
            Ok(false) => return Ok(candidate),
            Ok(true) => continue,
            Err(error) => {
                return Err(format!(
                    "failed to inspect attachment quarantine path {}: {error}",
                    candidate.display()
                ));
            }
        }
    }
    Err("failed to allocate a unique attachment quarantine path".to_string())
}

#[cfg(unix)]
fn path_to_c_string(path: &Path) -> io::Result<CString> {
    use std::os::unix::ffi::OsStrExt;
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))
}

#[cfg(target_os = "linux")]
fn move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let source = path_to_c_string(source)?;
    let destination = path_to_c_string(destination)?;
    // SAFETY: both paths are valid, NUL-terminated C strings retained for the call.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let source = path_to_c_string(source)?;
    let destination = path_to_c_string(destination)?;
    // SAFETY: both paths are valid, NUL-terminated C strings retained for the call.
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
fn move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // No REPLACE_EXISTING flag: a late destination creation must win. WRITE_THROUGH
    // makes the namespace update durable before the command acknowledges it.
    // SAFETY: both buffers are NUL-terminated and retained for the call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn move_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            format!(
                "failed to flush attachment install directory {}: {error}",
                path.display()
            )
        })
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    // Windows namespace moves use MOVEFILE_WRITE_THROUGH above. A stale journal
    // deletion after a crash is harmless because recovery verifies all file hashes.
    Ok(())
}

fn sync_file(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| {
            format!(
                "failed to flush attachment install stage {}: {error}",
                path.display()
            )
        })
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove attachment install file {}: {error}",
            path.display()
        )),
    }
}

fn write_journal(
    root: &Path,
    journal_path: &Path,
    journal: &AttachmentInstallJournal,
) -> Result<(), String> {
    let encoded = serde_json::to_vec(journal)
        .map_err(|error| format!("failed to encode attachment install journal: {error}"))?;
    let temp_path = root.join(format!(
        ".mindwtr-attachment-install-journal-{}.tmp",
        random_suffix()
    ));
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("failed to create attachment install journal: {error}"))?;
        file.write_all(&encoded)
            .map_err(|error| format!("failed to write attachment install journal: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to flush attachment install journal: {error}"))?;
        move_no_replace(&temp_path, journal_path)
            .map_err(|error| format!("failed to publish attachment install journal: {error}"))?;
        sync_directory(root)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

fn remove_journal(root: &Path, journal_path: &Path) -> Result<(), String> {
    remove_file_if_present(journal_path)?;
    sync_directory(root)
}

fn read_journal(path: &Path) -> Result<AttachmentInstallJournal, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect attachment install journal: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_INSTALL_JOURNAL_BYTES
    {
        return Err("attachment install journal is not a bounded regular file".to_string());
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("failed to read attachment install journal: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to decode attachment install journal: {error}"))
}

fn path_exists_as_regular_file(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(format!(
            "attachment install recovery path is not a regular file: {}",
            path.display()
        )),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "failed to inspect attachment install recovery path {}: {error}",
            path.display()
        )),
    }
}

fn cleanup_recovery_stage(
    path: &Path,
    keep_stage: &Path,
    expected_hash: &str,
) -> Result<(), String> {
    if path == keep_stage || !path_exists_as_regular_file(path)? {
        return Ok(());
    }
    if sha256_file(path)? == expected_hash {
        remove_file_if_present(path)?;
    }
    Ok(())
}

fn recover_existing_install(
    root: &Path,
    target_path: &Path,
    keep_stage: &Path,
) -> Result<RecoveryOutcome, String> {
    let journal_path = target_journal_path(root, target_path);
    if !journal_path
        .try_exists()
        .map_err(|error| format!("failed to inspect attachment install journal: {error}"))?
    {
        return Ok(RecoveryOutcome::None);
    }

    let journal = read_journal(&journal_path)?;
    if journal.version != INSTALL_JOURNAL_VERSION || journal.target_path != target_path {
        return Err("attachment install journal does not match the requested target".to_string());
    }
    validate_path_in_root(root, &journal.staged_path, "journal stage")?;
    validate_path_in_root(root, &journal.target_path, "journal target")?;
    if let Some(quarantine_path) = journal.quarantine_path.as_deref() {
        validate_path_in_root(root, quarantine_path, "journal quarantine")?;
    }
    let staged_sha256 = normalize_sha256(&journal.staged_sha256)?;

    if let Some(quarantine_path) = journal.quarantine_path.as_deref() {
        if path_exists_as_regular_file(quarantine_path)? {
            if path_exists_as_regular_file(target_path)? {
                if sha256_file(target_path)? == staged_sha256 {
                    if journal.staged_path != target_path
                        && journal.staged_path.try_exists().unwrap_or(false)
                    {
                        return Err("attachment install recovery stage is unexpectedly occupied"
                            .to_string());
                    }
                    move_no_replace(target_path, &journal.staged_path).map_err(|error| {
                        format!("failed to quarantine incomplete remote attachment during recovery: {error}")
                    })?;
                    sync_directory(root)?;
                } else {
                    remove_journal(root, &journal_path)?;
                    return Ok(RecoveryOutcome::Conflict {
                        preserved_path: quarantine_path.to_path_buf(),
                    });
                }
            }
            match move_no_replace(quarantine_path, target_path) {
                Ok(()) => {
                    sync_directory(root)?;
                    cleanup_recovery_stage(&journal.staged_path, keep_stage, &staged_sha256)?;
                    remove_journal(root, &journal_path)?;
                    return Ok(RecoveryOutcome::None);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    remove_journal(root, &journal_path)?;
                    return Ok(RecoveryOutcome::Conflict {
                        preserved_path: quarantine_path.to_path_buf(),
                    });
                }
                Err(error) => {
                    return Err(format!(
                        "failed to restore quarantined attachment during recovery: {error}"
                    ));
                }
            }
        }
    }

    let target_hash = if path_exists_as_regular_file(target_path)? {
        Some(sha256_file(target_path)?)
    } else {
        None
    };
    cleanup_recovery_stage(&journal.staged_path, keep_stage, &staged_sha256)?;
    remove_journal(root, &journal_path)?;
    if target_hash.as_deref() == Some(staged_sha256.as_str()) {
        Ok(RecoveryOutcome::Installed {
            sha256: staged_sha256,
        })
    } else {
        Ok(RecoveryOutcome::None)
    }
}

fn install_attachment_download_in_root_with_hook<F>(
    root: &Path,
    staged_path: &Path,
    target_path: &Path,
    expected: AttachmentInstallExpectation,
    mut after_quarantine: F,
) -> Result<AttachmentInstallOutcome, String>
where
    F: FnMut(&Path) -> Result<(), String>,
{
    validate_install_paths(root, staged_path, target_path)?;
    sync_file(staged_path)?;
    let staged_sha256 = sha256_file(staged_path)?;

    match recover_existing_install(root, target_path, staged_path)? {
        RecoveryOutcome::Installed { sha256 } if sha256 == staged_sha256 => {
            remove_file_if_present(staged_path)?;
            sync_directory(root)?;
            return Ok(AttachmentInstallOutcome::Installed);
        }
        RecoveryOutcome::Installed { .. } => {
            return Ok(conflict(
                AttachmentInstallConflictReason::RecoveryConflict,
                Some(target_path),
            ));
        }
        RecoveryOutcome::Conflict { preserved_path } => {
            return Ok(conflict(
                AttachmentInstallConflictReason::RecoveryConflict,
                Some(&preserved_path),
            ));
        }
        RecoveryOutcome::None => {}
    }

    // Recovery may have consumed an old stage that happened to use the same path.
    validate_regular_file(staged_path, "stage")?;
    validate_optional_target(target_path)?;

    let expected = match expected {
        AttachmentInstallExpectation::Present { sha256 } => AttachmentInstallExpectation::Present {
            sha256: normalize_sha256(&sha256)?,
        },
        AttachmentInstallExpectation::Absent => AttachmentInstallExpectation::Absent,
    };
    let quarantine_path = match expected {
        AttachmentInstallExpectation::Present { .. } => Some(next_quarantine_path(root)?),
        AttachmentInstallExpectation::Absent => None,
    };
    let journal_path = target_journal_path(root, target_path);
    let journal = AttachmentInstallJournal {
        version: INSTALL_JOURNAL_VERSION,
        staged_path: staged_path.to_path_buf(),
        target_path: target_path.to_path_buf(),
        quarantine_path: quarantine_path.clone(),
        staged_sha256: staged_sha256.clone(),
        expected: expected.clone(),
    };
    write_journal(root, &journal_path, &journal)?;

    match expected {
        AttachmentInstallExpectation::Absent => match move_no_replace(staged_path, target_path) {
            Ok(()) => {
                sync_directory(root)?;
                remove_journal(root, &journal_path)?;
                Ok(AttachmentInstallOutcome::Installed)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                remove_journal(root, &journal_path)?;
                if sha256_file(target_path)? == staged_sha256 {
                    remove_file_if_present(staged_path)?;
                    sync_directory(root)?;
                    Ok(AttachmentInstallOutcome::Installed)
                } else {
                    Ok(conflict(
                        AttachmentInstallConflictReason::TargetExists,
                        Some(target_path),
                    ))
                }
            }
            Err(error) => Err(format!(
                "failed to install absent attachment without replacement: {error}"
            )),
        },
        AttachmentInstallExpectation::Present {
            sha256: expected_sha256,
        } => {
            let quarantine_path =
                quarantine_path.expect("present installs always allocate quarantine");
            match move_no_replace(target_path, &quarantine_path) {
                Ok(()) => sync_directory(root)?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    remove_journal(root, &journal_path)?;
                    return Ok(conflict(
                        AttachmentInstallConflictReason::TargetMissing,
                        None,
                    ));
                }
                Err(error) => {
                    return Err(format!(
                        "failed to quarantine current attachment generation: {error}"
                    ));
                }
            }

            after_quarantine(target_path)?;

            if sha256_file(&quarantine_path)? != expected_sha256 {
                let preserved_path = match move_no_replace(&quarantine_path, target_path) {
                    Ok(()) => {
                        sync_directory(root)?;
                        target_path
                    }
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => &quarantine_path,
                    Err(error) => {
                        return Err(format!(
                            "failed to restore mismatched attachment generation: {error}"
                        ));
                    }
                };
                remove_journal(root, &journal_path)?;
                return Ok(conflict(
                    AttachmentInstallConflictReason::GenerationMismatch,
                    Some(preserved_path),
                ));
            }

            match move_no_replace(staged_path, target_path) {
                Ok(()) => sync_directory(root)?,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    remove_journal(root, &journal_path)?;
                    return Ok(conflict(
                        AttachmentInstallConflictReason::TargetExists,
                        Some(&quarantine_path),
                    ));
                }
                Err(error) => {
                    return Err(format!("failed to publish attachment download: {error}"))
                }
            }

            // A writer that already held the displaced inode can continue writing it
            // after the rename. Re-hash before deleting quarantine; if it changed, put
            // those local bytes back and keep the downloaded bytes staged for retry.
            if sha256_file(&quarantine_path)? != expected_sha256 {
                move_no_replace(target_path, staged_path).map_err(|error| {
                    format!("failed to preserve downloaded bytes during rollback: {error}")
                })?;
                sync_directory(root)?;
                let preserved_path = match move_no_replace(&quarantine_path, target_path) {
                    Ok(()) => {
                        sync_directory(root)?;
                        target_path
                    }
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => &quarantine_path,
                    Err(error) => {
                        return Err(format!(
                            "failed to restore late local attachment edit: {error}"
                        ));
                    }
                };
                remove_journal(root, &journal_path)?;
                return Ok(conflict(
                    AttachmentInstallConflictReason::GenerationMismatch,
                    Some(preserved_path),
                ));
            }

            remove_file_if_present(&quarantine_path)?;
            sync_directory(root)?;
            remove_journal(root, &journal_path)?;
            Ok(AttachmentInstallOutcome::Installed)
        }
    }
}

fn install_attachment_download_in_root(
    root: &Path,
    staged_path: &Path,
    target_path: &Path,
    expected: AttachmentInstallExpectation,
) -> Result<AttachmentInstallOutcome, String> {
    install_attachment_download_in_root_with_hook(root, staged_path, target_path, expected, |_| {
        Ok(())
    })
}

#[tauri::command(async)]
pub(crate) fn install_attachment_download(
    app: tauri::AppHandle,
    staged_path: String,
    target_path: String,
    expected: AttachmentInstallExpectation,
) -> Result<AttachmentInstallOutcome, String> {
    use fs2::FileExt as _;

    let root = crate::storage::get_data_dir(&app).join("attachments");
    validate_managed_root(&root)?;
    let lock_path = root.join(".mindwtr-attachment-installer.lock");
    match fs::symlink_metadata(&lock_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("attachment installer lock must be a regular file".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to inspect attachment installer lock: {error}"
            ))
        }
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
        .map_err(|error| format!("failed to open attachment installer lock: {error}"))?;
    lock.lock_exclusive()
        .map_err(|error| format!("failed to acquire attachment installer lock: {error}"))?;
    let result = install_attachment_download_in_root(
        &root,
        Path::new(&staged_path),
        Path::new(&target_path),
        expected,
    );
    let unlock_result = lock
        .unlock()
        .map_err(|error| format!("failed to release attachment installer lock: {error}"));
    match (result, unlock_result) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(outcome), Ok(())) => Ok(outcome),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, PathBuf, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("attachments");
        fs::create_dir(&root).expect("attachments dir");
        let stage = root.join(".download-stage");
        let target = root.join("attachment.txt");
        (temp, root, stage, target)
    }

    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn artifacts(root: &Path) -> Vec<String> {
        let mut names = fs::read_dir(root)
            .expect("read root")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.starts_with(".mindwtr-attachment-"))
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    #[test]
    fn absent_install_is_no_replace_and_preserves_a_late_target() {
        let (_temp, root, stage, target) = fixture();
        fs::write(&stage, b"remote").expect("stage");
        fs::write(&target, b"late-local").expect("target");

        let outcome = install_attachment_download_in_root(
            &root,
            &stage,
            &target,
            AttachmentInstallExpectation::Absent,
        )
        .expect("install outcome");

        assert!(matches!(
            outcome,
            AttachmentInstallOutcome::Conflict {
                reason: AttachmentInstallConflictReason::TargetExists,
                ..
            }
        ));
        assert_eq!(fs::read(&target).expect("target bytes"), b"late-local");
        assert_eq!(fs::read(&stage).expect("stage bytes"), b"remote");
        assert!(artifacts(&root).is_empty());
    }

    #[test]
    fn absent_install_moves_the_complete_stage_into_an_empty_target() {
        let (_temp, root, stage, target) = fixture();
        fs::write(&stage, b"remote").expect("stage");

        let outcome = install_attachment_download_in_root(
            &root,
            &stage,
            &target,
            AttachmentInstallExpectation::Absent,
        )
        .expect("install outcome");

        assert_eq!(outcome, AttachmentInstallOutcome::Installed);
        assert_eq!(fs::read(&target).expect("target bytes"), b"remote");
        assert!(!stage.exists());
        assert!(artifacts(&root).is_empty());
    }

    #[test]
    fn exact_present_generation_is_replaced() {
        let (_temp, root, stage, target) = fixture();
        fs::write(&stage, b"remote-winner").expect("stage");
        fs::write(&target, b"expected-local").expect("target");

        let outcome = install_attachment_download_in_root(
            &root,
            &stage,
            &target,
            AttachmentInstallExpectation::Present {
                sha256: hash(b"expected-local"),
            },
        )
        .expect("install outcome");

        assert_eq!(outcome, AttachmentInstallOutcome::Installed);
        assert_eq!(fs::read(&target).expect("target bytes"), b"remote-winner");
        assert!(!stage.exists());
        assert!(artifacts(&root).is_empty());
    }

    #[test]
    fn mismatched_present_generation_is_restored_and_preserved() {
        let (_temp, root, stage, target) = fixture();
        fs::write(&stage, b"remote-winner").expect("stage");
        fs::write(&target, b"late-local").expect("target");

        let outcome = install_attachment_download_in_root(
            &root,
            &stage,
            &target,
            AttachmentInstallExpectation::Present {
                sha256: hash(b"expected-local"),
            },
        )
        .expect("install outcome");

        assert!(matches!(
            outcome,
            AttachmentInstallOutcome::Conflict {
                reason: AttachmentInstallConflictReason::GenerationMismatch,
                ..
            }
        ));
        assert_eq!(fs::read(&target).expect("target bytes"), b"late-local");
        assert_eq!(fs::read(&stage).expect("stage bytes"), b"remote-winner");
        assert!(artifacts(&root).is_empty());
    }

    #[test]
    fn target_created_after_quarantine_wins_without_replacement() {
        let (_temp, root, stage, target) = fixture();
        fs::write(&stage, b"remote-winner").expect("stage");
        fs::write(&target, b"expected-local").expect("target");

        let outcome = install_attachment_download_in_root_with_hook(
            &root,
            &stage,
            &target,
            AttachmentInstallExpectation::Present {
                sha256: hash(b"expected-local"),
            },
            |target_path| {
                fs::write(target_path, b"late-local")
                    .map_err(|error| format!("late target fixture failed: {error}"))
            },
        )
        .expect("install outcome");

        assert!(matches!(
            &outcome,
            AttachmentInstallOutcome::Conflict {
                reason: AttachmentInstallConflictReason::TargetExists,
                ..
            }
        ));
        assert_eq!(fs::read(&target).expect("target bytes"), b"late-local");
        assert_eq!(fs::read(&stage).expect("stage bytes"), b"remote-winner");
        let preserved = match outcome {
            AttachmentInstallOutcome::Conflict {
                preserved_path: Some(path),
                ..
            } => PathBuf::from(path),
            other => panic!("expected preserved conflict, got {other:?}"),
        };
        assert_eq!(
            fs::read(preserved).expect("quarantine bytes"),
            b"expected-local"
        );
        assert_eq!(artifacts(&root).len(), 1);
    }

    #[test]
    fn recovery_restores_a_target_quarantined_before_publish() {
        let (_temp, root, stage, target) = fixture();
        fs::write(&stage, b"remote-winner").expect("stage");
        fs::write(&target, b"expected-local").expect("target");
        let quarantine = next_quarantine_path(&root).expect("quarantine path");
        let journal_path = target_journal_path(&root, &target);
        let journal = AttachmentInstallJournal {
            version: INSTALL_JOURNAL_VERSION,
            staged_path: stage.clone(),
            target_path: target.clone(),
            quarantine_path: Some(quarantine.clone()),
            staged_sha256: hash(b"remote-winner"),
            expected: AttachmentInstallExpectation::Present {
                sha256: hash(b"expected-local"),
            },
        };
        write_journal(&root, &journal_path, &journal).expect("journal");
        move_no_replace(&target, &quarantine).expect("quarantine target");

        let recovered = recover_existing_install(&root, &target, &stage).expect("recover");

        assert!(matches!(recovered, RecoveryOutcome::None));
        assert_eq!(fs::read(&target).expect("target bytes"), b"expected-local");
        assert_eq!(fs::read(&stage).expect("stage bytes"), b"remote-winner");
        assert!(artifacts(&root).is_empty());
    }

    #[test]
    fn recovery_rolls_back_an_unacknowledged_published_replacement() {
        let (_temp, root, stage, target) = fixture();
        fs::write(&stage, b"remote-winner").expect("stage");
        fs::write(&target, b"expected-local").expect("target");
        let quarantine = next_quarantine_path(&root).expect("quarantine path");
        let journal_path = target_journal_path(&root, &target);
        let journal = AttachmentInstallJournal {
            version: INSTALL_JOURNAL_VERSION,
            staged_path: stage.clone(),
            target_path: target.clone(),
            quarantine_path: Some(quarantine.clone()),
            staged_sha256: hash(b"remote-winner"),
            expected: AttachmentInstallExpectation::Present {
                sha256: hash(b"expected-local"),
            },
        };
        write_journal(&root, &journal_path, &journal).expect("journal");
        move_no_replace(&target, &quarantine).expect("quarantine target");
        move_no_replace(&stage, &target).expect("publish stage");

        let keep = root.join("new-download-stage");
        fs::write(&keep, b"new-remote").expect("new stage");
        let recovered = recover_existing_install(&root, &target, &keep).expect("recover");

        assert!(matches!(recovered, RecoveryOutcome::None));
        assert_eq!(fs::read(&target).expect("target bytes"), b"expected-local");
        assert!(!stage.exists());
        assert_eq!(fs::read(&keep).expect("new stage bytes"), b"new-remote");
        assert!(artifacts(&root).is_empty());
    }

    #[test]
    fn directories_and_paths_outside_the_managed_root_are_rejected() {
        let (temp, root, stage, target) = fixture();
        fs::create_dir(&stage).expect("stage directory");
        let directory_error = install_attachment_download_in_root(
            &root,
            &stage,
            &target,
            AttachmentInstallExpectation::Absent,
        )
        .expect_err("directory stage must fail");
        assert!(directory_error.contains("regular file"));

        fs::remove_dir(&stage).expect("remove stage directory");
        fs::write(&stage, b"remote").expect("stage");
        let outside = temp.path().join("outside.txt");
        let outside_error = install_attachment_download_in_root(
            &root,
            &stage,
            &outside,
            AttachmentInstallExpectation::Absent,
        )
        .expect_err("outside target must fail");
        assert!(outside_error.contains("direct child"));

        fs::create_dir(&target).expect("target directory");
        let target_error = install_attachment_download_in_root(
            &root,
            &stage,
            &target,
            AttachmentInstallExpectation::Absent,
        )
        .expect_err("directory target must fail");
        assert!(target_error.contains("absent or a regular file"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_stage_target_and_root_are_rejected() {
        use std::os::unix::fs::symlink;

        let (temp, root, stage, target) = fixture();
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"outside").expect("outside");
        symlink(&outside, &stage).expect("stage symlink");
        let stage_error = install_attachment_download_in_root(
            &root,
            &stage,
            &target,
            AttachmentInstallExpectation::Absent,
        )
        .expect_err("stage symlink must fail");
        assert!(stage_error.contains("regular file"));

        fs::remove_file(&stage).expect("remove stage symlink");
        fs::write(&stage, b"remote").expect("stage");
        symlink(&outside, &target).expect("target symlink");
        let target_error = install_attachment_download_in_root(
            &root,
            &stage,
            &target,
            AttachmentInstallExpectation::Absent,
        )
        .expect_err("target symlink must fail");
        assert!(target_error.contains("absent or a regular file"));

        let symlink_root = temp.path().join("symlink-root");
        symlink(&root, &symlink_root).expect("root symlink");
        let root_error = install_attachment_download_in_root(
            &symlink_root,
            &stage,
            &target,
            AttachmentInstallExpectation::Absent,
        )
        .expect_err("root symlink must fail");
        assert!(root_error.contains("real directory"));
    }

    #[test]
    fn tauri_command_is_registered() {
        let source = include_str!("lib.rs");
        let handler = source
            .split_once("tauri::generate_handler![")
            .and_then(|(_, rest)| rest.split_once("])").map(|(commands, _)| commands))
            .expect("Tauri command handler should be present");
        assert!(handler.contains("install_attachment_download,"));
    }
}
