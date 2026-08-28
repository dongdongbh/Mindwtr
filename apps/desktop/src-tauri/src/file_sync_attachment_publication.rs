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
const PRIVATE_DIRECTORY_PREFIX: &str = ".mindwtr-install-";
const PRIVATE_DIRECTORY_SUFFIX: &str = ".candidate";
const PRIVATE_STAGE_NAME: &str = "stage";

#[cfg(windows)]
const RETAINED_DIRECTORY_ACCESS: u32 =
    windows_sys::Win32::Foundation::GENERIC_READ | windows_sys::Win32::Foundation::GENERIC_WRITE;
#[cfg(windows)]
const _: () = assert!(
    RETAINED_DIRECTORY_ACCESS & windows_sys::Win32::Foundation::GENERIC_WRITE
        == windows_sys::Win32::Foundation::GENERIC_WRITE
);

// Publication is hardened against crashes and cooperating Mindwtr writers by
// retaining a mode-0700 private namespace and exact file/directory handles.
// A malicious same-UID process that can bypass that private namespace is out
// of scope; ambiguous identity or provider behavior must still fail closed.

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
    handle: File,
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
    private_directory_path: PathBuf,
    #[serde(default)]
    private_directory_identity: Option<DirectoryIdentity>,
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
        // FlushFileBuffers requires a handle opened with GENERIC_WRITE. Keep
        // the retained handle itself flush-capable so publication durability
        // never reopens a replaceable directory name.
        options
            .access_mode(RETAINED_DIRECTORY_ACCESS)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
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
    Ok(BoundDirectory { identity, handle })
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

    fn attachments_directory(&self) -> Result<&BoundDirectory, String> {
        self.attachments
            .as_ref()
            .ok_or_else(|| "File Sync attachments directory is not bound".to_string())
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
    let expected_private_directory = sync_root.join(ATTACHMENTS_DIR_NAME).join(format!(
        "{PRIVATE_DIRECTORY_PREFIX}{}{PRIVATE_DIRECTORY_SUFFIX}",
        entry.operation_id
    ));
    if entry.private_directory_path != expected_private_directory {
        return Err("Attachment publication private namespace ownership is invalid".to_string());
    }
    let expected_scratch = expected_private_directory.join(PRIVATE_STAGE_NAME);
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

#[cfg(windows)]
fn move_replace_durably(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

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
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn move_replace_durably(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
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

#[cfg(unix)]
fn sync_bound_directory(directory: &BoundDirectory) -> Result<(), String> {
    directory.handle.sync_all().map_err(|error| {
        format!("Failed to flush retained attachment publication directory: {error}")
    })
}

#[cfg(windows)]
fn sync_bound_directory(directory: &BoundDirectory) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::FlushFileBuffers;

    if unsafe { FlushFileBuffers(directory.handle.as_raw_handle()) } == 0 {
        Err(format!(
            "Failed to flush retained attachment publication directory: {}",
            io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn sync_bound_directory(_directory: &BoundDirectory) -> Result<(), String> {
    Err("Retained attachment directory flushing is unsupported".to_string())
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

fn replace_entry(data_dir: &Path, entry: &PublicationEntry) -> Result<PathBuf, String> {
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
        move_replace_durably(&temp_path, &final_path)
            .map_err(|error| format!("Failed to update attachment publication journal: {error}"))?;
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

fn open_entry_private_directory(entry: &PublicationEntry) -> Result<BoundDirectory, String> {
    let expected_identity = entry.private_directory_identity.as_ref().ok_or_else(|| {
        "Attachment publication private namespace was not fully reserved".to_string()
    })?;
    let directory = open_directory_no_follow(&entry.private_directory_path, "private publication")?;
    if &directory.identity != expected_identity {
        return Err("Attachment publication private namespace changed".to_string());
    }
    Ok(directory)
}

fn remove_empty_private_directory(entry: &PublicationEntry) -> Result<(), String> {
    let directory = open_entry_private_directory(entry)?;
    directory.revalidate(&entry.private_directory_path, "private publication")?;
    fs::remove_dir(&entry.private_directory_path)
        .map_err(|error| format!("Failed to remove attachment publication namespace: {error}"))?;
    sync_directory(
        entry
            .private_directory_path
            .parent()
            .ok_or_else(|| "Attachment publication namespace has no parent".to_string())?,
    )
}

fn remove_owned_scratch(entry: &PublicationEntry) -> Result<(), String> {
    if entry.private_directory_identity.is_none() {
        return match fs::symlink_metadata(&entry.private_directory_path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            _ => Err(
                "Attachment publication private namespace ownership was not recorded; preserving it"
                    .to_string(),
            ),
        };
    }
    let directory = open_entry_private_directory(entry)?;
    match fs::symlink_metadata(&entry.scratch_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("Journal-owned attachment scratch is not a regular file".to_string())
        }
        Ok(_) => {
            fs::remove_file(&entry.scratch_path).map_err(|error| {
                format!("Failed to remove journal-owned attachment scratch: {error}")
            })?;
            directory.revalidate(&entry.private_directory_path, "private publication")?;
            sync_directory(&entry.private_directory_path)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => Err(format!(
            "Failed to inspect journal-owned attachment scratch: {error}"
        ))?,
    }
    drop(directory);
    remove_empty_private_directory(entry)
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
        let private_directory_path = sync_root.join(ATTACHMENTS_DIR_NAME).join(format!(
            "{PRIVATE_DIRECTORY_PREFIX}{operation_id}{PRIVATE_DIRECTORY_SUFFIX}"
        ));
        let scratch_path = private_directory_path.join(PRIVATE_STAGE_NAME);
        match fs::symlink_metadata(&private_directory_path) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to inspect reserved attachment scratch path: {error}"
                ))
            }
        }
        let mut entry = PublicationEntry {
            version: JOURNAL_VERSION,
            operation_id: operation_id.clone(),
            sync_root: sync_root.to_path_buf(),
            scratch_path: scratch_path.clone(),
            private_directory_path: private_directory_path.clone(),
            private_directory_identity: None,
            target_path: target_path.to_path_buf(),
            expected_size,
            expected_sha256: expected_sha256.clone(),
            sync_root_identity: sync_root_identity.clone(),
            attachments_identity: attachments_identity.clone(),
        };
        let journal_path = write_entry(data_dir, &entry)?;
        match fs::create_dir(&private_directory_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                remove_entry_durably(&journal_path)?;
                continue;
            }
            Err(error) => {
                // The durable journal intentionally remains: recovery can
                // distinguish a missing namespace from an ambiguous one.
                return Err(format!(
                    "Failed to create private attachment publication namespace: {error}"
                ));
            }
        }
        restrict_to_owner(&private_directory_path, 0o700)?;
        sync_directory(
            private_directory_path
                .parent()
                .expect("private publication namespace has attachments parent"),
        )?;
        let private_directory =
            open_directory_no_follow(&private_directory_path, "private publication")?;
        entry.private_directory_identity = Some(private_directory.identity.clone());
        replace_entry(data_dir, &entry)?;
        if let Err(error) = publication_root.validate_entry_identities(&entry) {
            // The private namespace exists and is journal-owned. Preserve the
            // journal so restart recovery can remove only that exact identity.
            return Err(error);
        }
        return Ok(PublicationReservation {
            operation_id,
            scratch_path: scratch_path.to_string_lossy().into_owned(),
        });
    }
    Err("Failed to allocate a unique attachment publication scratch path".to_string())
}

fn open_verified_stage(entry: &PublicationEntry) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
        use windows_sys::Win32::Storage::FileSystem::{
            DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };
        options
            .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options
        .open(&entry.scratch_path)
        .map_err(|error| format!("Failed to open attachment generation stage: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to inspect attachment generation stage: {error}"))?;
    if !metadata.is_file() || metadata.len() != entry.expected_size {
        return Err("Attachment generation stage size changed before publication".to_string());
    }
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read attachment generation stage: {error}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "Attachment generation stage size overflow".to_string())?;
        if total > entry.expected_size {
            return Err("Attachment generation stage size changed before publication".to_string());
        }
        hasher.update(&buffer[..read]);
    }
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if total != entry.expected_size || actual_sha256 != entry.expected_sha256 {
        return Err("Attachment generation stage failed integrity verification".to_string());
    }
    if file
        .metadata()
        .map_err(|error| format!("Failed to restat attachment generation stage: {error}"))?
        .len()
        != entry.expected_size
    {
        return Err("Attachment generation stage size changed before publication".to_string());
    }
    file.sync_all()
        .map_err(|error| format!("Failed to flush attachment generation stage: {error}"))?;
    Ok(file)
}

fn named_stage_matches_handle(
    private_directory: &BoundDirectory,
    stage: &File,
    _entry: &PublicationEntry,
) -> Result<bool, String> {
    #[cfg(unix)]
    {
        use std::mem::MaybeUninit;
        use std::os::fd::AsRawFd as _;

        let name = CString::new(PRIVATE_STAGE_NAME).expect("static stage name has no NUL");
        let mut stat = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: the retained private directory descriptor is valid and the
        // output storage is initialized by a successful fstatat call.
        if unsafe {
            libc::fstatat(
                private_directory.handle.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(format!(
                "Failed to revalidate private attachment stage: {}",
                io::Error::last_os_error()
            ));
        }
        let named = unsafe { stat.assume_init() };
        let opened = stage
            .metadata()
            .map_err(|error| format!("Failed to identify verified attachment stage: {error}"))?;
        use std::os::unix::fs::MetadataExt as _;
        return Ok(named.st_mode & libc::S_IFMT == libc::S_IFREG
            && named.st_dev as u64 == opened.dev()
            && named.st_ino as u64 == opened.ino());
    }

    #[cfg(windows)]
    {
        let named = open_verified_stage(_entry)?;
        return Ok(directory_identity(&named)? == directory_identity(stage)?);
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (private_directory, stage, _entry);
        Err("Exact attachment stage identity is unsupported on this platform".to_string())
    }
}

#[cfg(target_os = "linux")]
fn publish_linux_with_fallback<Link, Rename>(link: Link, rename: Rename) -> io::Result<bool>
where
    Link: FnOnce() -> io::Result<()>,
    Rename: FnOnce() -> io::Result<()>,
{
    match link() {
        Ok(()) => Ok(false),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::EXDEV) | Some(libc::EPERM) | Some(libc::EOPNOTSUPP) | Some(libc::ENOSYS)
            ) =>
        {
            rename()?;
            Ok(true)
        }
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn publish_exact_stage(
    private_directory: &BoundDirectory,
    stage: &File,
    attachments_directory: &BoundDirectory,
    target_name: &std::ffi::OsStr,
) -> io::Result<()> {
    use std::os::fd::AsRawFd as _;
    use std::os::unix::ffi::OsStrExt as _;

    let source = CString::new(format!("/proc/self/fd/{}", stage.as_raw_fd()))
        .expect("file descriptor path has no NUL");
    let target = CString::new(target_name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "target contains a NUL byte"))?;
    // `AT_EMPTY_PATH` requires a capability on Linux. The documented
    // `/proc/self/fd` + `AT_SYMLINK_FOLLOW` form links the exact open inode.
    let stage_name = CString::new(PRIVATE_STAGE_NAME).expect("static stage name has no NUL");
    let renamed = publish_linux_with_fallback(
        || {
            let result = unsafe {
                libc::linkat(
                    libc::AT_FDCWD,
                    source.as_ptr(),
                    attachments_directory.handle.as_raw_fd(),
                    target.as_ptr(),
                    libc::AT_SYMLINK_FOLLOW,
                )
            };
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        },
        || {
            // Some virtual mounts support same-filesystem rename but not hard
            // links. The private directory is retained, mode 0700, and the
            // caller just proved `stage` still names the verified open inode.
            let result = unsafe {
                libc::renameat2(
                    private_directory.handle.as_raw_fd(),
                    stage_name.as_ptr(),
                    attachments_directory.handle.as_raw_fd(),
                    target.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            };
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        },
    )?;
    if renamed {
        return Ok(());
    }
    if unsafe { libc::unlinkat(private_directory.handle.as_raw_fd(), stage_name.as_ptr(), 0) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn publish_exact_stage(
    private_directory: &BoundDirectory,
    _stage: &File,
    attachments_directory: &BoundDirectory,
    target_name: &std::ffi::OsStr,
) -> io::Result<()> {
    use std::os::fd::AsRawFd as _;
    use std::os::unix::ffi::OsStrExt as _;
    let source = CString::new(PRIVATE_STAGE_NAME).expect("static stage name has no NUL");
    let target = CString::new(target_name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "target contains a NUL byte"))?;
    let result = unsafe {
        libc::renameatx_np(
            private_directory.handle.as_raw_fd(),
            source.as_ptr(),
            attachments_directory.handle.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn publish_exact_stage(
    _private_directory: &BoundDirectory,
    stage: &File,
    attachments_directory: &BoundDirectory,
    target_name: &std::ffi::OsStr,
) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO,
    };

    let target = target_name.encode_wide().collect::<Vec<_>>();
    // `FILE_RENAME_INFO` is a variable-length record. Its x64 Rust layout has
    // trailing padding after `FileName`; Windows expects the payload length to
    // begin at the field offset, not at `size_of - 2`.
    let fixed = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let target_bytes = target
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target name is too long"))?;
    let buffer_bytes = fixed
        .checked_add(target_bytes)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "rename buffer overflowed"))?;
    let information_bytes = u32::try_from(buffer_bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "target name is too long"))?;
    let target_bytes = u32::try_from(target_bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "target name is too long"))?;
    // `FILE_RENAME_INFO` has pointer alignment. A byte vector does not promise
    // enough alignment for the typed header.
    let words = buffer_bytes.div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0_usize; words];
    let information = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*information).Anonymous.ReplaceIfExists = false;
        (*information).RootDirectory = attachments_directory.handle.as_raw_handle();
        (*information).FileNameLength = target_bytes;
        std::ptr::copy_nonoverlapping(
            target.as_ptr(),
            (*information).FileName.as_mut_ptr(),
            target.len(),
        );
        if SetFileInformationByHandle(
            stage.as_raw_handle(),
            FileRenameInfo,
            information.cast(),
            information_bytes,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn publish_exact_stage(
    _private_directory: &BoundDirectory,
    _stage: &File,
    _attachments_directory: &BoundDirectory,
    _target_name: &std::ffi::OsStr,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "exact attachment publication is unsupported",
    ))
}

fn publish_with_hook<F>(
    data_dir: &Path,
    publication_root: &mut PublicationRoot,
    operation_id: &str,
    before_publish: F,
) -> Result<PublicationAttempt, String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let _guard = journal_lock();
    let (path, entry) = read_owned_entry(data_dir, publication_root, operation_id)?;
    publication_root.validate_entry_identities(&entry)?;
    let private_directory = open_entry_private_directory(&entry)?;
    let stage = open_verified_stage(&entry)?;
    before_publish(&entry.scratch_path)?;
    publication_root.validate_entry_identities(&entry)?;
    private_directory.revalidate(&entry.private_directory_path, "private publication")?;
    if !named_stage_matches_handle(&private_directory, &stage, &entry)? {
        return Err("Verified attachment stage name changed before publication".to_string());
    }
    let target_name = entry
        .target_path
        .file_name()
        .ok_or_else(|| "Attachment publication target has no file name".to_string())?;
    let attachments_directory = publication_root.attachments_directory()?;
    match publish_exact_stage(
        &private_directory,
        &stage,
        attachments_directory,
        target_name,
    ) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Ok(PublicationAttempt::AlreadyExists)
        }
        Err(error) => return Err(format!("Failed to publish attachment generation: {error}")),
    }
    sync_bound_directory(attachments_directory)?;
    sync_bound_directory(&private_directory)?;
    drop(stage);
    drop(private_directory);
    remove_empty_private_directory(&entry)?;
    publication_root.validate_entry_identities(&entry)?;
    remove_entry_durably(&path)?;
    Ok(PublicationAttempt::Published)
}

pub(crate) fn publish(
    data_dir: &Path,
    publication_root: &mut PublicationRoot,
    operation_id: &str,
) -> Result<PublicationAttempt, String> {
    publish_with_hook(data_dir, publication_root, operation_id, |_| Ok(()))
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

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
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
            .join("peer-generation.tmp");
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
            reserve(&data_dir, &mut root, &target, 3, &digest(b"new")).expect("reserve");
        let scratch = PathBuf::from(&reservation.scratch_path);
        fs::write(&scratch, b"new").expect("scratch");
        fs::write(&target, b"peer").expect("peer target");

        let outcome = publish(&data_dir, &mut root, &reservation.operation_id).expect("collision");
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
            reserve(&data_dir, &mut root, &target, 3, &digest(b"new")).expect("reserve");
        let scratch = PathBuf::from(&reservation.scratch_path);
        fs::write(&scratch, b"new").expect("scratch");

        let outcome = publish(&data_dir, &mut root, &reservation.operation_id).expect("publish");
        assert_eq!(outcome, PublicationAttempt::Published);
        assert_eq!(fs::read(&target).expect("target"), b"new");
        assert!(!scratch.exists());
        assert!(!entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());
    }

    #[test]
    fn verified_stage_name_swap_is_rejected_before_target_or_journal_mutation() {
        let (_temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &digest(b"new")).expect("reserve");
        let scratch = PathBuf::from(&reservation.scratch_path);
        fs::write(&scratch, b"new").expect("scratch");
        let displaced = scratch.with_file_name("displaced-stage");

        let error = publish_with_hook(
            &data_dir,
            &mut root,
            &reservation.operation_id,
            |verified_name| {
                fs::rename(verified_name, &displaced).map_err(|error| error.to_string())?;
                fs::write(verified_name, b"bad").map_err(|error| error.to_string())?;
                Ok(())
            },
        )
        .expect_err("name swap must fail closed");

        assert!(error.contains("name changed"));
        assert!(!target.exists());
        assert_eq!(
            fs::read(displaced).expect("verified bytes retained"),
            b"new"
        );
        assert_eq!(fs::read(scratch).expect("replacement retained"), b"bad");
        assert!(entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());
    }

    #[test]
    fn transient_attachments_replacement_inside_publication_hook_writes_nothing() {
        let (temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &digest(b"new")).expect("reserve");
        fs::write(&reservation.scratch_path, b"new").expect("scratch");
        let attachments = sync_root.join(ATTACHMENTS_DIR_NAME);
        let original = temp.path().join("held-attachments");

        let error = publish_with_hook(&data_dir, &mut root, &reservation.operation_id, |_| {
            if let Err(error) = fs::rename(&attachments, &original) {
                #[cfg(windows)]
                if error.kind() == io::ErrorKind::PermissionDenied {
                    return Err(
                        "retained attachments handle blocked directory replacement".to_string()
                    );
                }
                return Err(error.to_string());
            }
            fs::create_dir(&attachments).map_err(|error| error.to_string())?;
            Ok(())
        })
        .expect_err("replacement must fail closed");

        #[cfg(not(windows))]
        assert!(error.contains("attachments directory changed"));
        #[cfg(windows)]
        assert!(error.contains("retained attachments handle blocked directory replacement"));
        assert!(!target.exists());
        assert!(!attachments
            .join(target.file_name().expect("target name"))
            .exists());
        assert!(entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_capability_failure_uses_relative_rename_but_collision_does_not() {
        let rename_calls = std::cell::Cell::new(0_u8);
        let renamed = publish_linux_with_fallback(
            || Err(io::Error::from_raw_os_error(libc::EOPNOTSUPP)),
            || {
                rename_calls.set(rename_calls.get() + 1);
                Ok(())
            },
        )
        .expect("capability fallback");
        assert!(renamed);
        assert_eq!(rename_calls.get(), 1);

        let error = publish_linux_with_fallback(
            || Err(io::Error::from(io::ErrorKind::AlreadyExists)),
            || panic!("a target collision must never fall back"),
        )
        .expect_err("collision remains a collision");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
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
        #[cfg(not(windows))]
        let scratch_relative = Path::new(&reservation.scratch_path)
            .strip_prefix(sync_root.join(ATTACHMENTS_DIR_NAME))
            .expect("scratch relative path")
            .to_owned();

        #[cfg(windows)]
        {
            fs::write(&reservation.scratch_path, b"original").expect("original scratch");
            let original_root = temp.path().join("original-sync-root");
            let error = fs::rename(&sync_root, &original_root)
                .expect_err("retained Windows handles must block root replacement");
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert_eq!(
                fs::read(&reservation.scratch_path).expect("original remains"),
                b"original"
            );
            assert!(!target.exists());
            assert!(entry_path(&data_dir, &sync_root, &reservation.operation_id).exists());
            return;
        }

        #[cfg(not(windows))]
        {
            let original_root = temp.path().join("original-sync-root");
            fs::rename(&sync_root, &original_root).expect("move leased root");
            let original_scratch = original_root
                .join(ATTACHMENTS_DIR_NAME)
                .join(&scratch_relative);
            fs::write(&original_scratch, b"original").expect("original scratch");

            let replacement_attachments = sync_root.join(ATTACHMENTS_DIR_NAME);
            fs::create_dir_all(&replacement_attachments).expect("replacement root");
            let replacement_scratch = replacement_attachments.join(&scratch_relative);
            fs::create_dir_all(
                replacement_scratch
                    .parent()
                    .expect("replacement private parent"),
            )
            .expect("replacement private namespace");
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
    }

    #[test]
    fn attachments_replacement_fails_closed_without_touching_either_generation() {
        let (temp, data_dir, sync_root, target) = fixture();
        let mut root = bind(&sync_root);
        let reservation =
            reserve(&data_dir, &mut root, &target, 3, &"b".repeat(64)).expect("reserve");
        let scratch_relative = Path::new(&reservation.scratch_path)
            .strip_prefix(sync_root.join(ATTACHMENTS_DIR_NAME))
            .expect("scratch relative path")
            .to_owned();
        let attachments = sync_root.join(ATTACHMENTS_DIR_NAME);
        let original_attachments = temp.path().join("original-attachments");
        fs::rename(&attachments, &original_attachments).expect("move leased attachments");
        let original_scratch = original_attachments.join(&scratch_relative);
        fs::write(&original_scratch, b"original").expect("original scratch");

        fs::create_dir(&attachments).expect("replacement attachments");
        let replacement_scratch = attachments.join(&scratch_relative);
        fs::create_dir_all(
            replacement_scratch
                .parent()
                .expect("replacement private parent"),
        )
        .expect("replacement private namespace");
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
        let scratch_relative = Path::new(&reservation.scratch_path)
            .strip_prefix(sync_root.join(ATTACHMENTS_DIR_NAME))
            .expect("scratch relative path")
            .to_owned();
        let attachments = sync_root.join(ATTACHMENTS_DIR_NAME);
        let original_attachments = temp.path().join("original-attachments");
        fs::rename(&attachments, &original_attachments).expect("move leased attachments");
        let original_scratch = original_attachments.join(&scratch_relative);
        fs::write(&original_scratch, b"original").expect("original scratch");

        let external = temp.path().join("external-attachments");
        fs::create_dir(&external).expect("external attachments");
        let external_scratch = external.join(&scratch_relative);
        fs::create_dir_all(external_scratch.parent().expect("external private parent"))
            .expect("external private namespace");
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
