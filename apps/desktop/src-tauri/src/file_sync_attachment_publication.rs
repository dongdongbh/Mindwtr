use crate::config::restrict_to_owner;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

const JOURNAL_VERSION: u8 = 2;
const JOURNAL_DIR_NAME: &str = "file-sync-attachment-publications-v2";
const JOURNAL_ENTRY_PREFIX: &str = "publication-v2-";
const JOURNAL_ENTRY_SUFFIX: &str = ".json";
const JOURNAL_TEMP_SUFFIX: &str = ".tmp";
const JOURNAL_CLEARED_SUFFIX: &str = ".cleared";
const MAX_JOURNAL_ENTRY_BYTES: u64 = 16 * 1024;
const MAX_JOURNAL_ENTRIES: usize = 1024;
const ATTACHMENTS_DIR_NAME: &str = "attachments";
const SCRATCH_PREFIX: &str = ".mindwtr-attachment-generation-";
const SCRATCH_SUFFIX: &str = ".tmp";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct DirectoryIdentity {
    device_id: u64,
    file_id: u64,
}

#[derive(Debug)]
struct BoundDirectory {
    identity: DirectoryIdentity,
    // Retaining the original directory handle prevents its identity from being
    // recycled while the renderer owns the File Sync lease.
    _handle: File,
}

#[derive(Debug)]
pub(crate) struct PublicationRoot {
    sync_root: PathBuf,
    root: BoundDirectory,
    attachments: Option<BoundDirectory>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct PublicationEntry {
    version: u8,
    operation_id: String,
    sync_root: PathBuf,
    scratch_path: PathBuf,
    target_path: PathBuf,
    expected_size: u64,
    expected_sha256: String,
    sync_root_identity: DirectoryIdentity,
    attachments_identity: DirectoryIdentity,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicationReservation {
    pub(crate) operation_id: String,
    pub(crate) scratch_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PublicationAttempt {
    Published,
    AlreadyExists,
}

#[cfg(unix)]
fn directory_identity(file: &File) -> Result<DirectoryIdentity, String> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to inspect File Sync directory handle: {error}"))?;
    let identity = DirectoryIdentity {
        device_id: metadata.dev(),
        file_id: metadata.ino(),
    };
    if identity.file_id == 0 {
        return Err("File Sync filesystem does not expose a stable directory identity".to_string());
    }
    Ok(identity)
}

#[cfg(windows)]
fn directory_identity(file: &File) -> Result<DirectoryIdentity, String> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the retained File owns a valid handle and `information` remains
    // writable for the duration of the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(format!(
            "Failed to identify File Sync directory handle: {}",
            io::Error::last_os_error()
        ));
    }
    let identity = DirectoryIdentity {
        device_id: u64::from(information.dwVolumeSerialNumber),
        file_id: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    };
    if identity.file_id == 0 {
        return Err("File Sync filesystem does not expose a stable directory identity".to_string());
    }
    Ok(identity)
}

#[cfg(not(any(unix, windows)))]
fn directory_identity(_file: &File) -> Result<DirectoryIdentity, String> {
    Err("File Sync directory identity is unsupported on this platform".to_string())
}

fn open_directory_no_follow(path: &Path, label: &str) -> Result<BoundDirectory, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect File Sync {label} directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "File Sync {label} path must be a real directory, not a link or reparse point"
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "File Sync {label} path must be a real directory, not a link or reparse point"
            ));
        }
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let handle = options
        .open(path)
        .map_err(|error| format!("Failed to open File Sync {label} directory: {error}"))?;
    let opened_metadata = handle
        .metadata()
        .map_err(|error| format!("Failed to inspect File Sync {label} directory: {error}"))?;
    if !opened_metadata.is_dir() {
        return Err(format!("File Sync {label} path must be a directory"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if opened_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "File Sync {label} path must be a real directory, not a link or reparse point"
            ));
        }
    }
    let identity = directory_identity(&handle)?;
    Ok(BoundDirectory {
        identity,
        _handle: handle,
    })
}

impl BoundDirectory {
    fn revalidate(&self, path: &Path, label: &str) -> Result<(), String> {
        let current = open_directory_no_follow(path, label)?;
        if current.identity != self.identity {
            return Err(format!(
                "File Sync {label} directory changed while its lease was held"
            ));
        }
        Ok(())
    }
}

impl PublicationRoot {
    pub(crate) fn bind(sync_root: &Path) -> Result<Self, String> {
        if !path_is_lexically_normal(sync_root) {
            return Err("File Sync root must be absolute and normalized".to_string());
        }
        Ok(Self {
            sync_root: sync_root.to_path_buf(),
            root: open_directory_no_follow(sync_root, "root")?,
            attachments: None,
        })
    }

    pub(crate) fn sync_root(&self) -> &Path {
        &self.sync_root
    }

    pub(crate) fn revalidate_root(&self) -> Result<(), String> {
        self.root.revalidate(&self.sync_root, "root")
    }

    fn revalidate_with_attachments(
        &mut self,
    ) -> Result<(DirectoryIdentity, DirectoryIdentity), String> {
        self.revalidate_root()?;
        let attachments_path = self.sync_root.join(ATTACHMENTS_DIR_NAME);
        match &self.attachments {
            Some(attachments) => attachments.revalidate(&attachments_path, "attachments")?,
            None => {
                self.attachments =
                    Some(open_directory_no_follow(&attachments_path, "attachments")?);
            }
        }
        // Catch a root rename/replacement that occurred while opening the child.
        self.revalidate_root()?;
        let attachments = self
            .attachments
            .as_ref()
            .expect("attachments binding was initialized");
        Ok((self.root.identity.clone(), attachments.identity.clone()))
    }

    fn validate_entry_identities(&mut self, entry: &PublicationEntry) -> Result<(), String> {
        let (root_identity, attachments_identity) = self.revalidate_with_attachments()?;
        if entry.sync_root_identity != root_identity
            || entry.attachments_identity != attachments_identity
        {
            return Err(
                "Attachment publication journal directory identity no longer matches the held lease"
                    .to_string(),
            );
        }
        Ok(())
    }
}

fn journal_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn normalize_sha256(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if !is_hex(&normalized, 64) {
        return Err("Attachment publication SHA-256 must be 64 hexadecimal characters".to_string());
    }
    Ok(normalized)
}

fn random_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut output = String::with_capacity(32);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
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

fn root_fingerprint(sync_root: &Path) -> String {
    format!(
        "{:x}",
        Sha256::digest(sync_root.to_string_lossy().as_bytes())
    )
}

fn journal_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(JOURNAL_DIR_NAME)
}

fn entry_file_name(sync_root: &Path, operation_id: &str) -> String {
    format!(
        "{JOURNAL_ENTRY_PREFIX}{}-{operation_id}{JOURNAL_ENTRY_SUFFIX}",
        root_fingerprint(sync_root)
    )
}

fn entry_path(data_dir: &Path, sync_root: &Path, operation_id: &str) -> PathBuf {
    journal_dir(data_dir).join(entry_file_name(sync_root, operation_id))
}

fn matching_entry_prefix(sync_root: &Path) -> String {
    format!("{JOURNAL_ENTRY_PREFIX}{}-", root_fingerprint(sync_root))
}

fn validate_journal_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create attachment publication journal: {error}"))?;
    restrict_to_owner(path, 0o700)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect attachment publication journal: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Attachment publication journal must be a real directory".to_string());
    }
    Ok(())
}

fn validate_generation_target(sync_root: &Path, target_path: &Path) -> Result<(), String> {
    if !path_is_lexically_normal(sync_root) || !path_is_lexically_normal(target_path) {
        return Err("Attachment publication paths must be absolute and normalized".to_string());
    }
    let attachments_dir = sync_root.join(ATTACHMENTS_DIR_NAME);
    if target_path.parent() != Some(attachments_dir.as_path()) {
        return Err(
            "Attachment publication target must be a direct child of the leased attachments directory"
                .to_string(),
        );
    }
    let target_name = target_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Attachment publication target has no valid file name".to_string())?;
    if !target_name.split('.').any(|part| is_hex(part, 64)) {
        return Err("Attachment publication target is not hash-qualified".to_string());
    }
    Ok(())
}

fn validate_entry(entry: &PublicationEntry, sync_root: &Path) -> Result<(), String> {
    if entry.version != JOURNAL_VERSION {
        return Err("Attachment publication journal version is unsupported".to_string());
    }
    if !is_hex(&entry.operation_id, 32) {
        return Err("Attachment publication operation id is invalid".to_string());
    }
    if entry.sync_root != sync_root {
        return Err(
            "Attachment publication journal belongs to a different sync folder".to_string(),
        );
    }
    validate_generation_target(sync_root, &entry.target_path)?;
    let expected_scratch = sync_root.join(ATTACHMENTS_DIR_NAME).join(format!(
        "{SCRATCH_PREFIX}{}{SCRATCH_SUFFIX}",
        entry.operation_id
    ));
    if entry.scratch_path != expected_scratch {
        return Err("Attachment publication scratch ownership is invalid".to_string());
    }
    normalize_sha256(&entry.expected_sha256)?;
    Ok(())
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
    // SAFETY: both paths are retained NUL-terminated strings.
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
    // SAFETY: both paths are retained NUL-terminated strings.
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

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both buffers are retained and NUL-terminated.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
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
        .map_err(|error| format!("Failed to flush attachment publication directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    // Journal publication/removal uses MOVEFILE_WRITE_THROUGH on Windows.
    Ok(())
}

fn write_entry(data_dir: &Path, entry: &PublicationEntry) -> Result<PathBuf, String> {
    let directory = journal_dir(data_dir);
    validate_journal_dir(&directory)?;
    let final_path = entry_path(data_dir, &entry.sync_root, &entry.operation_id);
    let temp_path = directory.join(format!(
        ".{}-{}-{JOURNAL_TEMP_SUFFIX}",
        entry.operation_id,
        random_id()
    ));
    let encoded = serde_json::to_vec(entry)
        .map_err(|error| format!("Failed to encode attachment publication journal: {error}"))?;
    if encoded.len() as u64 > MAX_JOURNAL_ENTRY_BYTES {
        return Err("Attachment publication journal entry is too large".to_string());
    }

    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("Failed to create attachment publication journal: {error}"))?;
        restrict_to_owner(&temp_path, 0o600)?;
        file.write_all(&encoded)
            .and_then(|_| file.sync_all())
            .map_err(|error| {
                format!("Failed to persist attachment publication journal: {error}")
            })?;
        drop(file);
        move_no_replace(&temp_path, &final_path).map_err(|error| {
            format!("Failed to publish attachment publication journal: {error}")
        })?;
        sync_directory(&directory)?;
        Ok(final_path.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn open_regular_no_follow(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Failed to open attachment publication journal: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to inspect attachment publication journal: {error}"))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("Attachment publication journal must not be a reparse point".to_string());
        }
    }
    if !metadata.is_file() || metadata.len() > MAX_JOURNAL_ENTRY_BYTES {
        return Err("Attachment publication journal is not a bounded regular file".to_string());
    }
    Ok(file)
}

fn read_entry(path: &Path) -> Result<PublicationEntry, String> {
    let file = open_regular_no_follow(path)?;
    let mut bytes = Vec::new();
    file.take(MAX_JOURNAL_ENTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read attachment publication journal: {error}"))?;
    if bytes.len() as u64 > MAX_JOURNAL_ENTRY_BYTES {
        return Err("Attachment publication journal entry is too large".to_string());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Attachment publication journal is invalid".to_string())
}

fn read_owned_entry(
    data_dir: &Path,
    publication_root: &mut PublicationRoot,
    operation_id: &str,
) -> Result<(PathBuf, PublicationEntry), String> {
    if !is_hex(operation_id, 32) {
        return Err("Attachment publication operation id is invalid".to_string());
    }
    let sync_root = publication_root.sync_root().to_path_buf();
    let path = entry_path(data_dir, &sync_root, operation_id);
    let entry = read_entry(&path)?;
    validate_entry(&entry, &sync_root)?;
    if path.file_name().and_then(|name| name.to_str())
        != Some(entry_file_name(&sync_root, operation_id).as_str())
    {
        return Err("Attachment publication journal file name is invalid".to_string());
    }
    publication_root.validate_entry_identities(&entry)?;
    Ok((path, entry))
}

fn remove_entry_durably(path: &Path) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "Attachment publication journal has no parent".to_string())?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("Attachment publication journal must be a regular file".to_string())
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect attachment publication journal for removal: {error}"
            ))
        }
    }

    #[cfg(windows)]
    {
        let cleared = directory.join(format!(".{}-{JOURNAL_CLEARED_SUFFIX}", random_id()));
        move_no_replace(path, &cleared)
            .map_err(|error| format!("Failed to retire attachment publication journal: {error}"))?;
        let _ = fs::remove_file(cleared);
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to remove attachment publication journal: {error}"))?;
        sync_directory(directory)
    }
}

fn remove_owned_scratch(entry: &PublicationEntry) -> Result<(), String> {
    match fs::symlink_metadata(&entry.scratch_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("Journal-owned attachment scratch is not a regular file".to_string())
        }
        Ok(_) => {
            fs::remove_file(&entry.scratch_path).map_err(|error| {
                format!("Failed to remove journal-owned attachment scratch: {error}")
            })?;
            sync_directory(
                entry
                    .scratch_path
                    .parent()
                    .ok_or_else(|| "Attachment scratch has no parent".to_string())?,
            )?;
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to inspect journal-owned attachment scratch: {error}"
        )),
    }
}

fn count_active_entries(directory: &Path) -> Result<usize, String> {
    let mut count = 0_usize;
    for item in fs::read_dir(directory)
        .map_err(|error| format!("Failed to read attachment publication journal: {error}"))?
    {
        let item = item.map_err(|error| {
            format!("Failed to inspect attachment publication journal: {error}")
        })?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with(JOURNAL_ENTRY_PREFIX) && name.ends_with(JOURNAL_ENTRY_SUFFIX) {
            count += 1;
            if count >= MAX_JOURNAL_ENTRIES {
                break;
            }
        }
    }
    Ok(count)
}

pub(crate) fn reserve(
    data_dir: &Path,
    publication_root: &mut PublicationRoot,
    target_path: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<PublicationReservation, String> {
    let _guard = journal_lock();
    let sync_root = publication_root.sync_root().to_path_buf();
    validate_generation_target(&sync_root, target_path)?;
    let expected_sha256 = normalize_sha256(expected_sha256)?;
    let (sync_root_identity, attachments_identity) =
        publication_root.revalidate_with_attachments()?;
    let directory = journal_dir(data_dir);
    validate_journal_dir(&directory)?;
    if count_active_entries(&directory)? >= MAX_JOURNAL_ENTRIES {
        return Err("Attachment publication journal is full".to_string());
    }

    for _ in 0..16 {
        let operation_id = random_id();
        let scratch_path = sync_root
            .join(ATTACHMENTS_DIR_NAME)
            .join(format!("{SCRATCH_PREFIX}{operation_id}{SCRATCH_SUFFIX}"));
        match fs::symlink_metadata(&scratch_path) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to inspect reserved attachment scratch path: {error}"
                ))
            }
        }
        let entry = PublicationEntry {
            version: JOURNAL_VERSION,
            operation_id: operation_id.clone(),
            sync_root: sync_root.to_path_buf(),
            scratch_path: scratch_path.clone(),
            target_path: target_path.to_path_buf(),
            expected_size,
            expected_sha256: expected_sha256.clone(),
            sync_root_identity: sync_root_identity.clone(),
            attachments_identity: attachments_identity.clone(),
        };
        let journal_path = write_entry(data_dir, &entry)?;
        if let Err(error) = publication_root.validate_entry_identities(&entry) {
            // No scratch path has escaped this function yet, so this local
            // journal can be safely retired without touching the sync folder.
            let _ = remove_entry_durably(&journal_path);
            return Err(error);
        }
        return Ok(PublicationReservation {
            operation_id,
            scratch_path: scratch_path.to_string_lossy().into_owned(),
        });
    }
    Err("Failed to allocate a unique attachment publication scratch path".to_string())
}

pub(crate) fn publish_with<F>(
    data_dir: &Path,
    publication_root: &mut PublicationRoot,
    operation_id: &str,
    publish: F,
) -> Result<PublicationAttempt, String>
where
    F: FnOnce(&Path, &Path, u64, &str) -> Result<PublicationAttempt, String>,
{
    let _guard = journal_lock();
    let (path, entry) = read_owned_entry(data_dir, publication_root, operation_id)?;
    publication_root.validate_entry_identities(&entry)?;
    let outcome = publish(
        &entry.scratch_path,
        &entry.target_path,
        entry.expected_size,
        &entry.expected_sha256,
    )?;
    publication_root.validate_entry_identities(&entry)?;
    if outcome == PublicationAttempt::Published {
        remove_entry_durably(&path)?;
    }
    Ok(outcome)
}

pub(crate) fn abandon(
    data_dir: &Path,
    publication_root: &mut PublicationRoot,
    operation_id: &str,
) -> Result<(), String> {
    let _guard = journal_lock();
    let (path, entry) = read_owned_entry(data_dir, publication_root, operation_id)?;
    publication_root.validate_entry_identities(&entry)?;
    remove_owned_scratch(&entry)?;
    publication_root.validate_entry_identities(&entry)?;
    remove_entry_durably(&path)
}

pub(crate) fn recover(
    data_dir: &Path,
    publication_root: &mut PublicationRoot,
) -> Result<usize, String> {
    let _guard = journal_lock();
    publication_root.revalidate_root()?;
    let sync_root = publication_root.sync_root().to_path_buf();
    let directory = journal_dir(data_dir);
    validate_journal_dir(&directory)?;
    let prefix = matching_entry_prefix(&sync_root);
    let mut matching_paths = Vec::new();
    let mut total_entries = 0_usize;
    for item in fs::read_dir(&directory)
        .map_err(|error| format!("Failed to read attachment publication journal: {error}"))?
    {
        let item = item.map_err(|error| {
            format!("Failed to inspect attachment publication journal: {error}")
        })?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with(JOURNAL_ENTRY_PREFIX) && name.ends_with(JOURNAL_ENTRY_SUFFIX) {
            total_entries += 1;
            if total_entries > MAX_JOURNAL_ENTRIES {
                return Err("Attachment publication journal exceeds its entry limit".to_string());
            }
            if name.starts_with(&prefix) {
                matching_paths.push(item.path());
            }
        } else if name.ends_with(JOURNAL_TEMP_SUFFIX) || name.ends_with(JOURNAL_CLEARED_SUFFIX) {
            // This directory is device-local and private to this module. These
            // names can only be interrupted journal publications/removals.
            let _ = fs::remove_file(item.path());
        }
    }

    let mut recovered = 0_usize;
    for path in matching_paths {
        let entry = read_entry(&path)?;
        validate_entry(&entry, &sync_root)?;
        if path.file_name().and_then(|name| name.to_str())
            != Some(entry_file_name(&sync_root, &entry.operation_id).as_str())
        {
            return Err("Attachment publication journal file name is invalid".to_string());
        }
        publication_root.validate_entry_identities(&entry)?;
        remove_owned_scratch(&entry)?;
        publication_root.validate_entry_identities(&entry)?;
        remove_entry_durably(&path)?;
        recovered += 1;
    }
    Ok(recovered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_dir = temp.path().join("device-data");
        let sync_root = temp.path().join("sync-root");
        let attachments = sync_root.join(ATTACHMENTS_DIR_NAME);
        fs::create_dir_all(&data_dir).expect("device data");
        fs::create_dir_all(&attachments).expect("attachments");
        let target = attachments.join(format!("attachment-1.{}.txt", "a".repeat(64)));
        (temp, data_dir, sync_root, target)
    }

    fn bind(sync_root: &Path) -> PublicationRoot {
        PublicationRoot::bind(sync_root).expect("bind publication root")
    }

    #[test]
    fn reservation_is_durable_before_scratch_creation_and_empty_recovery_clears_it() {
        let (_temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let journal = entry_path(&data_dir, &sync_root, &reservation.operation_id);
        assert!(journal.exists());
        assert!(!Path::new(&reservation.scratch_path).exists());

        drop(root);
        let mut restarted_root = bind(&sync_root);
        assert_eq!(recover(&data_dir, &mut restarted_root).expect("recover"), 1);
        assert!(!journal.exists());
        assert!(!target.exists());
    }

    #[test]
    fn recovery_removes_only_the_exact_journal_owned_regular_scratch() {
        let (_temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let owned = PathBuf::from(&reservation.scratch_path);
        fs::write(&owned, b"partial").expect("owned scratch");
        let peer = sync_root
            .join(ATTACHMENTS_DIR_NAME)
            .join(format!("{SCRATCH_PREFIX}peer{SCRATCH_SUFFIX}"));
        fs::write(&peer, b"peer").expect("peer scratch");

        assert_eq!(recover(&data_dir, &mut root).expect("recover"), 1);
        assert!(!owned.exists());
        assert_eq!(fs::read(peer).expect("peer remains"), b"peer");
        assert!(!target.exists());
    }

    #[test]
    fn recovery_after_publication_preserves_the_generation_and_clears_the_journal() {
        let (_temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let scratch = PathBuf::from(&reservation.scratch_path);
        fs::write(&scratch, b"new").expect("scratch");
        fs::rename(&scratch, &target).expect("simulate completed publication");

        assert_eq!(recover(&data_dir, &mut root).expect("recover"), 1);
        assert_eq!(fs::read(target).expect("target remains"), b"new");
    }

    #[test]
    fn collision_keeps_the_owned_scratch_until_explicit_abandon() {
        let (_temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let scratch = PathBuf::from(&reservation.scratch_path);
        fs::write(&scratch, b"new").expect("scratch");

        let outcome = publish_with(
            &data_dir,
            &mut root,
            &reservation.operation_id,
            |_scratch, _target, _size, _sha| Ok(PublicationAttempt::AlreadyExists),
        )
        .expect("collision");
        assert_eq!(outcome, PublicationAttempt::AlreadyExists);
        assert!(scratch.exists());
        assert!(entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());

        abandon(&data_dir, &mut root, &reservation.operation_id).expect("abandon");
        assert!(!scratch.exists());
        assert!(!entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());
    }

    #[test]
    fn successful_publication_consumes_scratch_and_journal() {
        let (_temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let scratch = PathBuf::from(&reservation.scratch_path);
        fs::write(&scratch, b"new").expect("scratch");

        let outcome = publish_with(
            &data_dir,
            &mut root,
            &reservation.operation_id,
            |scratch, target, _size, _sha| {
                fs::rename(scratch, target).map_err(|error| error.to_string())?;
                Ok(PublicationAttempt::Published)
            },
        )
        .expect("publish");
        assert_eq!(outcome, PublicationAttempt::Published);
        assert_eq!(fs::read(&target).expect("target"), b"new");
        assert!(!scratch.exists());
        assert!(!entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());
    }

    #[test]
    fn another_root_cannot_abandon_or_recover_an_owned_scratch() {
        let (temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let scratch = PathBuf::from(&reservation.scratch_path);
        fs::write(&scratch, b"owned").expect("scratch");
        let other_root = temp.path().join("other-sync");
        fs::create_dir_all(other_root.join(ATTACHMENTS_DIR_NAME)).expect("other root");
        let mut other = bind(&other_root);

        assert_eq!(recover(&data_dir, &mut other).expect("other recovery"), 0);
        assert!(scratch.exists());
        assert!(abandon(&data_dir, &mut other, &reservation.operation_id).is_err());
        assert!(scratch.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_replacement_fails_closed_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let (temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let scratch = PathBuf::from(&reservation.scratch_path);
        let outside = temp.path().join("outside");
        fs::write(&outside, b"outside").expect("outside");
        symlink(&outside, &scratch).expect("symlink");

        let error = recover(&data_dir, &mut root).expect_err("must fail closed");
        assert!(error.contains("not a regular file"));
        assert_eq!(fs::read(outside).expect("outside remains"), b"outside");
        assert!(entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());
    }

    #[test]
    fn malformed_matching_journal_fails_closed_without_scanning_shared_files() {
        let (_temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let scratch = PathBuf::from(&reservation.scratch_path);
        fs::write(&scratch, b"owned").expect("scratch");
        let journal = entry_path(&data_dir, &sync_root, &reservation.operation_id);
        fs::write(&journal, b"not-json").expect("corrupt journal");

        assert!(recover(&data_dir, &mut root).is_err());
        assert_eq!(fs::read(scratch).expect("scratch remains"), b"owned");
    }

    #[test]
    fn root_replacement_fails_closed_without_touching_either_generation() {
        let (temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let scratch_name = Path::new(&reservation.scratch_path)
            .file_name()
            .expect("scratch name")
            .to_owned();

        let original_root = temp.path().join("original-sync-root");
        fs::rename(&sync_root, &original_root).expect("move leased root");
        let original_scratch = original_root.join(ATTACHMENTS_DIR_NAME).join(&scratch_name);
        fs::write(&original_scratch, b"original").expect("original scratch");

        let replacement_attachments = sync_root.join(ATTACHMENTS_DIR_NAME);
        fs::create_dir_all(&replacement_attachments).expect("replacement root");
        let replacement_scratch = replacement_attachments.join(&scratch_name);
        fs::write(&replacement_scratch, b"replacement").expect("replacement scratch");

        let error = recover(&data_dir, &mut root).expect_err("root replacement must fail");
        assert!(error.contains("root directory changed"));
        assert_eq!(
            fs::read(original_scratch).expect("original remains"),
            b"original"
        );
        assert_eq!(
            fs::read(replacement_scratch).expect("replacement remains"),
            b"replacement"
        );
        assert!(entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());
    }

    #[test]
    fn attachments_replacement_fails_closed_without_touching_either_generation() {
        let (temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let scratch_name = Path::new(&reservation.scratch_path)
            .file_name()
            .expect("scratch name")
            .to_owned();
        let attachments = sync_root.join(ATTACHMENTS_DIR_NAME);
        let original_attachments = temp.path().join("original-attachments");
        fs::rename(&attachments, &original_attachments).expect("move leased attachments");
        let original_scratch = original_attachments.join(&scratch_name);
        fs::write(&original_scratch, b"original").expect("original scratch");

        fs::create_dir(&attachments).expect("replacement attachments");
        let replacement_scratch = attachments.join(&scratch_name);
        fs::write(&replacement_scratch, b"replacement").expect("replacement scratch");

        let error = abandon(&data_dir, &mut root, &reservation.operation_id)
            .expect_err("attachments replacement must fail");
        assert!(error.contains("attachments directory changed"));
        assert_eq!(
            fs::read(original_scratch).expect("original remains"),
            b"original"
        );
        assert_eq!(
            fs::read(replacement_scratch).expect("replacement remains"),
            b"replacement"
        );
        assert!(entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());
    }

    #[cfg(unix)]
    #[test]
    fn attachments_symlink_recovery_fails_closed_without_touching_external_file() {
        use std::os::unix::fs::symlink;

        let (temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let scratch_name = Path::new(&reservation.scratch_path)
            .file_name()
            .expect("scratch name")
            .to_owned();
        let attachments = sync_root.join(ATTACHMENTS_DIR_NAME);
        let original_attachments = temp.path().join("original-attachments");
        fs::rename(&attachments, &original_attachments).expect("move leased attachments");
        let original_scratch = original_attachments.join(&scratch_name);
        fs::write(&original_scratch, b"original").expect("original scratch");

        let external = temp.path().join("external-attachments");
        fs::create_dir(&external).expect("external attachments");
        let external_scratch = external.join(&scratch_name);
        fs::write(&external_scratch, b"external").expect("external scratch");
        symlink(&external, &attachments).expect("replace attachments with symlink");

        let error = recover(&data_dir, &mut root).expect_err("symlink must fail closed");
        assert!(error.contains("real directory"));
        assert_eq!(
            fs::read(original_scratch).expect("original remains"),
            b"original"
        );
        assert_eq!(
            fs::read(external_scratch).expect("external remains"),
            b"external"
        );
        assert!(entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());
    }
}
