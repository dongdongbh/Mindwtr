use crate::*;

#[cfg(target_os = "windows")]
fn has_windows_package_identity() -> bool {
    use windows_sys::Win32::Foundation::{APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER};
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;

    let mut package_name_len: u32 = 0;
    // Per Win32 docs, packaged apps return ERROR_INSUFFICIENT_BUFFER on a size probe.
    let status = unsafe { GetCurrentPackageFullName(&mut package_name_len, std::ptr::null_mut()) };
    if status == APPMODEL_ERROR_NO_PACKAGE {
        return false;
    }
    status == ERROR_INSUFFICIENT_BUFFER || (status == 0 && package_name_len > 0)
}

#[cfg(target_os = "windows")]
fn is_windowsapps_mindwtr_path(path: &str) -> bool {
    (path.contains("\\windowsapps\\") || path.contains("/windowsapps/")) && path.contains("mindwtr")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn is_windows_store_install() -> bool {
    #[cfg(target_os = "windows")]
    {
        if has_windows_package_identity() {
            return true;
        }

        if std::env::var_os("APPX_PACKAGE_FAMILY_NAME").is_some()
            || std::env::var_os("APPX_PACKAGE_FULL_NAME").is_some()
            || std::env::var_os("MSIX_PACKAGE_ROOT").is_some()
            || std::env::var_os("PACKAGE_FAMILY_NAME").is_some()
            || std::env::var_os("PACKAGE_FULL_NAME").is_some()
        {
            return true;
        }

        if let Some(path) = current_exe_path_lowercase() {
            if is_windowsapps_mindwtr_path(&path) {
                return true;
            }
        }
        if let Some(path) = current_exe_canonical_path_lowercase() {
            if is_windowsapps_mindwtr_path(&path) {
                return true;
            }
        }

        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[cfg(target_os = "windows")]
fn current_package_family_name() -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName;

    let mut len: u32 = 0;
    let status = unsafe { GetCurrentPackageFamilyName(&mut len, std::ptr::null_mut()) };
    if status != ERROR_INSUFFICIENT_BUFFER || len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize];
    let status = unsafe { GetCurrentPackageFamilyName(&mut len, buf.as_mut_ptr()) };
    if status != 0 {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16(&buf[..end]).ok().filter(|s| !s.is_empty())
}

// MSIX file-system virtualization silently redirects the app's writes under
// Roaming AppData into the package's LocalCache, so a path computed from the
// OS data dir names a file that does not exist there (#1135).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn local_cache_redirected_path(
    path: &Path,
    roaming_dir: &Path,
    local_dir: &Path,
    package_family_name: &str,
) -> Option<PathBuf> {
    let rest = path.strip_prefix(roaming_dir).ok()?;
    Some(
        local_dir
            .join("Packages")
            .join(package_family_name)
            .join("LocalCache")
            .join("Roaming")
            .join(rest),
    )
}

/// For MS Store installs, the LocalCache path where MSIX virtualization
/// actually lands `path`; `None` when the real path is the right one to show.
#[cfg_attr(not(target_os = "windows"), allow(unused_variables))]
pub(crate) fn windows_store_display_path(path: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if !is_windows_store_install() {
            return None;
        }
        let family = current_package_family_name()?;
        let roaming = dirs::data_dir()?;
        let local = dirs::data_local_dir()?;
        let candidate = local_cache_redirected_path(path, &roaming, &local, &family)?;
        // If write virtualization is off the redirected copy never exists;
        // keep showing the real path then.
        let exists = candidate.exists() || candidate.parent().is_some_and(|dir| dir.exists());
        exists.then_some(candidate)
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

fn current_exe_path_lowercase() -> Option<String> {
    env::current_exe()
        .ok()
        .and_then(|path| path.to_str().map(|value| value.to_lowercase()))
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn current_exe_canonical_path_lowercase() -> Option<String> {
    env::current_exe()
        .ok()
        .and_then(|path| fs::canonicalize(path).ok())
        .and_then(|path| path.to_str().map(|value| value.to_lowercase()))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn command_succeeds(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd)
        .args(args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn is_homebrew_cask_installed() -> bool {
    if command_succeeds("brew", &["list", "--cask", "mindwtr"]) {
        return true;
    }
    let brew_paths = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
    if brew_paths
        .iter()
        .any(|path| command_succeeds(path, &["list", "--cask", "mindwtr"]))
    {
        return true;
    }
    let caskroom_paths = [
        "/opt/homebrew/Caskroom/mindwtr",
        "/usr/local/Caskroom/mindwtr",
    ];
    caskroom_paths.iter().any(|path| Path::new(path).exists())
}

#[cfg(target_os = "linux")]
fn is_homebrew_install_linux() -> bool {
    if command_succeeds("brew", &["list", "--cask", "mindwtr"])
        || command_succeeds("brew", &["list", "mindwtr"])
    {
        return true;
    }
    let brew_paths = [
        "/home/linuxbrew/.linuxbrew/bin/brew",
        "/opt/homebrew/bin/brew",
        "/usr/local/bin/brew",
    ];
    if brew_paths.iter().any(|path| {
        command_succeeds(path, &["list", "--cask", "mindwtr"])
            || command_succeeds(path, &["list", "mindwtr"])
    }) {
        return true;
    }
    let install_paths = [
        "/home/linuxbrew/.linuxbrew/Caskroom/mindwtr",
        "/home/linuxbrew/.linuxbrew/Cellar/mindwtr",
        "/linuxbrew/.linuxbrew/Caskroom/mindwtr",
        "/linuxbrew/.linuxbrew/Cellar/mindwtr",
    ];
    install_paths.iter().any(|path| Path::new(path).exists())
}

#[cfg(target_os = "windows")]
fn is_winget_install_path(path: &str) -> bool {
    path.contains("\\microsoft\\winget\\packages\\") || path.contains("/microsoft/winget/packages/")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_scoop_install_path(path_lowercase: &str, scoop_root_lowercase: Option<&str>) -> bool {
    if path_lowercase.contains("\\scoop\\apps\\") || path_lowercase.contains("/scoop/apps/") {
        return true;
    }
    // Custom Scoop roots (SCOOP env var) can live anywhere, e.g. D:\tools.
    if let Some(root) = scoop_root_lowercase {
        let root = root.trim_end_matches(['\\', '/']);
        if !root.is_empty() {
            for separator in ['\\', '/'] {
                let apps_prefix = format!("{root}{separator}apps{separator}");
                if path_lowercase.starts_with(&apps_prefix) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn is_scoop_install() -> bool {
    let scoop_root = env::var("SCOOP").ok().map(|value| value.to_lowercase());
    [
        current_exe_path_lowercase(),
        current_exe_canonical_path_lowercase(),
    ]
    .into_iter()
    .flatten()
    .any(|path| is_scoop_install_path(&path, scoop_root.as_deref()))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn chocolatey_lib_dir_candidates(choco_install_env: Option<&str>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = choco_install_env {
        let root = root.trim().trim_end_matches(['\\', '/']);
        if !root.is_empty() {
            candidates.push(PathBuf::from(root).join("lib").join("mindwtr"));
        }
    }
    candidates.push(PathBuf::from("C:\\ProgramData\\chocolatey\\lib\\mindwtr"));
    candidates
}

#[cfg(target_os = "windows")]
fn is_chocolatey_install() -> bool {
    let choco_root = env::var("ChocolateyInstall").ok();
    chocolatey_lib_dir_candidates(choco_root.as_deref())
        .iter()
        .any(|path| path.is_dir())
}

#[cfg(target_os = "windows")]
fn command_output_lowercase(cmd: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(cmd)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut combined = String::from_utf8_lossy(&output.stdout).to_lowercase();
    if !output.stderr.is_empty() {
        combined.push('\n');
        combined.push_str(&String::from_utf8_lossy(&output.stderr).to_lowercase());
    }
    Some(combined)
}

#[cfg(target_os = "macos")]
fn find_macos_bundle_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|ancestor| {
            ancestor
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("app"))
                .unwrap_or(false)
        })
        .map(|ancestor| ancestor.to_path_buf())
}

fn resolve_arch_package_install_source(
    has_aur_bin: bool,
    has_aur_source: bool,
) -> Option<&'static str> {
    if has_aur_bin {
        return Some("aur-bin");
    }
    if has_aur_source {
        return Some("aur-source");
    }
    None
}

fn detect_install_source() -> String {
    #[cfg(target_os = "windows")]
    {
        if is_windows_store_install() {
            return "microsoft-store".to_string();
        }
        // Scoop extracts whatever the manifest ships (portable zip or setup
        // archive) under scoop\apps, so this must win over the portable check.
        if is_scoop_install() {
            return "scoop".to_string();
        }
        if crate::storage::is_portable_mode() {
            return "portable".to_string();
        }
        if env::var_os("WINGET_PACKAGE_IDENTIFIER").is_some() {
            return "winget".to_string();
        }
        if let Some(path) = current_exe_path_lowercase() {
            if is_winget_install_path(&path) {
                return "winget".to_string();
            }
        }
        if let Some(path) = current_exe_canonical_path_lowercase() {
            if is_winget_install_path(&path) {
                return "winget".to_string();
            }
        }
        // Chocolatey wraps the regular installer, so the exe path looks like a
        // direct install; the package record in the choco lib dir is the tell.
        if is_chocolatey_install() {
            return "chocolatey".to_string();
        }
        if let Some(list_output) = command_output_lowercase(
            "winget",
            &[
                "list",
                "--id",
                "dongdongbh.Mindwtr",
                "--exact",
                "--disable-interactivity",
            ],
        ) {
            if list_output.contains("dongdongbh.mindwtr") && list_output.contains("winget") {
                return "winget".to_string();
            }
        }
        return "direct".to_string();
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(exe_path) = env::current_exe() {
            if let Some(bundle_root) = find_macos_bundle_root(&exe_path) {
                if bundle_root
                    .join("Contents")
                    .join("_MASReceipt")
                    .join("receipt")
                    .exists()
                {
                    return "mac-app-store".to_string();
                }
            }
        }
        let is_homebrew_path =
            |path: &str| path.contains("/caskroom/") || path.contains("/homebrew/");
        if let Some(path) = current_exe_path_lowercase() {
            if is_homebrew_path(&path) {
                return "homebrew".to_string();
            }
        }
        if let Some(path) = current_exe_canonical_path_lowercase() {
            if is_homebrew_path(&path) {
                return "homebrew".to_string();
            }
        }
        if is_homebrew_cask_installed() {
            return "homebrew".to_string();
        }
        return "direct".to_string();
    }

    #[cfg(target_os = "linux")]
    {
        if is_flatpak() {
            if let Some(channel) = flatpak_install_channel() {
                return format!("flatpak:{channel}");
            }
            return "flatpak".to_string();
        }
        if env::var_os("SNAP").is_some() || env::var_os("SNAP_NAME").is_some() {
            return "snap".to_string();
        }
        if env::var_os("APPIMAGE").is_some() {
            return "appimage".to_string();
        }
        if let Some(path) = current_exe_path_lowercase() {
            if path.ends_with(".appimage") || path.contains(".appimage") {
                return "appimage".to_string();
            }
            if path.contains("/home/linuxbrew/") || path.contains("/linuxbrew/") {
                return "homebrew".to_string();
            }
        }
        if is_homebrew_install_linux() {
            return "homebrew".to_string();
        }
        if let Some(source) = resolve_arch_package_install_source(
            command_succeeds("pacman", &["-Qq", "mindwtr-bin"]),
            command_succeeds("pacman", &["-Qq", "mindwtr"]),
        ) {
            // Check the binary package first so packages that provide `mindwtr`
            // still report as `aur-bin` instead of collapsing into `aur-source`.
            return source.to_string();
        }
        if command_succeeds("dpkg-query", &["-W", "mindwtr"]) {
            return "apt".to_string();
        }
        if command_succeeds("rpm", &["-q", "mindwtr"]) {
            return "rpm".to_string();
        }
        return "direct".to_string();
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "direct".to_string()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MicrosoftStoreUpdateInfo {
    has_update: bool,
    latest_version: Option<String>,
}

#[cfg(target_os = "windows")]
fn package_version_string(version: windows::ApplicationModel::PackageVersion) -> String {
    format!(
        "{}.{}.{}.{}",
        version.Major, version.Minor, version.Build, version.Revision
    )
}

#[tauri::command]
pub(crate) async fn check_microsoft_store_update() -> Result<MicrosoftStoreUpdateInfo, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Services::Store::StoreContext;

        let context = StoreContext::GetDefault().map_err(|error| error.to_string())?;
        let updates = context
            .GetAppAndOptionalStorePackageUpdatesAsync()
            .map_err(|error| error.to_string())?
            .get()
            .map_err(|error| error.to_string())?;
        let count = updates.Size().map_err(|error| error.to_string())?;
        let mut latest_version: Option<String> = None;

        for index in 0..count {
            let update = updates.GetAt(index).map_err(|error| error.to_string())?;
            let package = update.Package().map_err(|error| error.to_string())?;
            let id = package.Id().map_err(|error| error.to_string())?;
            let version = id.Version().map_err(|error| error.to_string())?;
            latest_version = Some(package_version_string(version));
        }

        Ok(MicrosoftStoreUpdateInfo {
            has_update: count > 0,
            latest_version,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Microsoft Store update checks are only available on Windows.".to_string())
    }
}

#[tauri::command]
pub(crate) async fn get_install_source() -> String {
    tauri::async_runtime::spawn_blocking(detect_install_source)
        .await
        .unwrap_or_else(|_| "unknown".to_string())
}

pub(crate) fn parse_os_release_value(raw: &str) -> String {
    parse_toml_string_value(raw)
        .unwrap_or_else(|| raw.trim().trim_matches('"').trim_matches('\'').to_string())
}

// fs::read_to_string("/etc/os-release") — pure read, no shared state (B1).
#[tauri::command(async)]
pub(crate) fn get_linux_distro() -> Option<LinuxDistroInfo> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let content = fs::read_to_string("/etc/os-release").ok()?;
    let mut id: Option<String> = None;
    let mut id_like: Vec<String> = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("ID=") {
            if let Some(value) = line.split_once('=').map(|(_, v)| v) {
                let parsed = parse_os_release_value(value);
                if !parsed.is_empty() {
                    id = Some(parsed);
                }
            }
        } else if line.starts_with("ID_LIKE=") {
            if let Some(value) = line.split_once('=').map(|(_, v)| v) {
                let parsed = parse_os_release_value(value);
                if !parsed.is_empty() {
                    id_like = parsed
                        .split_whitespace()
                        .map(|item| item.trim().to_string())
                        .filter(|item| !item.is_empty())
                        .collect();
                }
            }
        }
    }

    Some(LinuxDistroInfo { id, id_like })
}

pub(crate) fn is_niri_session() -> bool {
    if env::var("NIRI_SOCKET").is_ok() {
        return true;
    }
    if let Ok(desktop) = env::var("XDG_CURRENT_DESKTOP") {
        return desktop.to_lowercase().contains("niri");
    }
    if let Ok(session) = env::var("XDG_SESSION_DESKTOP") {
        return session.to_lowercase().contains("niri");
    }
    false
}

pub(crate) fn parse_flatpak_install_channel(contents: &str) -> Option<String> {
    let mut in_instance = false;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_instance = trimmed.eq_ignore_ascii_case("[Instance]");
            continue;
        }
        if !in_instance {
            continue;
        }
        if let Some(branch) = trimmed.strip_prefix("branch=") {
            let value = branch.trim().to_lowercase();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn flatpak_install_channel() -> Option<String> {
    let contents = fs::read_to_string("/.flatpak-info").ok()?;
    parse_flatpak_install_channel(&contents)
}

pub(crate) fn is_flatpak() -> bool {
    env::var("FLATPAK_ID").is_ok()
        || env::var("FLATPAK_SANDBOX_DIR").is_ok()
        || Path::new("/.flatpak-info").exists()
}

pub(crate) fn diagnostics_enabled() -> bool {
    match env::var("MINDWTR_DIAGNOSTICS") {
        Ok(value) => matches!(value.to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        chocolatey_lib_dir_candidates, is_scoop_install_path, local_cache_redirected_path,
        resolve_arch_package_install_source,
    };
    use std::path::Path;

    #[test]
    fn local_cache_redirect_maps_roaming_paths_into_the_package_cache() {
        let mapped = local_cache_redirected_path(
            Path::new("/users/a/appdata/roaming/mindwtr/logs/mindwtr.log"),
            Path::new("/users/a/appdata/roaming"),
            Path::new("/users/a/appdata/local"),
            "DongdaLi.Mindwtr_abc123",
        )
        .expect("path under the roaming dir should map");
        assert_eq!(
            mapped,
            Path::new(
                "/users/a/appdata/local/Packages/DongdaLi.Mindwtr_abc123/LocalCache/Roaming/mindwtr/logs/mindwtr.log"
            )
        );
    }

    #[test]
    fn local_cache_redirect_leaves_paths_outside_roaming_alone() {
        assert!(local_cache_redirected_path(
            Path::new("/portable/profile/mindwtr/logs/mindwtr.log"),
            Path::new("/users/a/appdata/roaming"),
            Path::new("/users/a/appdata/local"),
            "DongdaLi.Mindwtr_abc123",
        )
        .is_none());
    }

    #[test]
    fn scoop_install_path_matches_default_root() {
        assert!(is_scoop_install_path(
            "c:\\users\\alice\\scoop\\apps\\mindwtr\\current\\mindwtr.exe",
            None
        ));
        assert!(is_scoop_install_path(
            "c:/users/alice/scoop/apps/mindwtr/1.1.0/mindwtr.exe",
            None
        ));
    }

    #[test]
    fn scoop_install_path_matches_custom_root_from_env() {
        assert!(is_scoop_install_path(
            "d:\\tools\\apps\\mindwtr\\current\\mindwtr.exe",
            Some("d:\\tools")
        ));
        assert!(!is_scoop_install_path(
            "d:\\tools\\apps\\mindwtr\\current\\mindwtr.exe",
            Some("d:\\other")
        ));
    }

    #[test]
    fn scoop_install_path_rejects_regular_installs() {
        assert!(!is_scoop_install_path(
            "c:\\program files\\mindwtr\\mindwtr.exe",
            None
        ));
        assert!(!is_scoop_install_path(
            "c:\\program files\\mindwtr\\mindwtr.exe",
            Some("")
        ));
    }

    #[test]
    fn chocolatey_lib_dir_candidates_prefer_env_root() {
        let candidates = chocolatey_lib_dir_candidates(Some("D:\\choco\\"));
        assert_eq!(candidates.len(), 2);
        assert!(candidates[0].ends_with("lib/mindwtr") || candidates[0].ends_with("lib\\mindwtr"));
        assert!(candidates[0].starts_with("D:\\choco"));

        let default_only = chocolatey_lib_dir_candidates(None);
        assert_eq!(default_only.len(), 1);
    }

    #[test]
    fn resolve_arch_package_install_source_prefers_bin_when_both_match() {
        assert_eq!(
            resolve_arch_package_install_source(true, true),
            Some("aur-bin")
        );
        assert_eq!(
            resolve_arch_package_install_source(true, false),
            Some("aur-bin")
        );
        assert_eq!(
            resolve_arch_package_install_source(false, true),
            Some("aur-source")
        );
        assert_eq!(resolve_arch_package_install_source(false, false), None);
    }
}
