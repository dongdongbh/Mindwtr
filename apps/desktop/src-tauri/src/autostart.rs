use crate::bool_setting_enabled;
use crate::config::{read_config, write_config_files};
#[cfg(target_os = "linux")]
use crate::install::is_flatpak;
#[cfg(target_os = "windows")]
use crate::install::is_windows_store_install;
use crate::storage::{get_config_path, get_secrets_path};
use tauri_plugin_autostart::ManagerExt;

#[cfg(target_os = "windows")]
const STORE_STARTUP_TASK_ID: &str = "MindwtrStartup";
const AUTOSTART_MIGRATION_COMPLETE: &str = "true";

fn autostart_error(error: tauri_plugin_autostart::Error) -> String {
    error.to_string()
}

#[tauri::command]
pub(crate) async fn get_launch_at_startup_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    if is_windows_store_install() {
        return get_store_launch_at_startup_enabled().await;
    }

    app.autolaunch().is_enabled().map_err(autostart_error)
}

#[tauri::command]
pub(crate) async fn set_launch_at_startup_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    if is_flatpak() {
        return set_flatpak_launch_at_startup_enabled(enabled).await;
    }

    #[cfg(target_os = "windows")]
    if is_windows_store_install() {
        return set_store_launch_at_startup_enabled(enabled).await;
    }

    let autostart = app.autolaunch();
    if enabled {
        autostart.enable().map_err(autostart_error)?;
    } else {
        autostart.disable().map_err(autostart_error)?;
    }
    autostart.is_enabled().map_err(autostart_error)
}

fn migrate_autostart_entry_with(
    already_migrated: bool,
    mut is_enabled: impl FnMut() -> Option<bool>,
    mut enable: impl FnMut() -> bool,
    mut persist_state: impl FnMut(&'static str) -> bool,
) -> bool {
    if already_migrated {
        return true;
    }

    if is_enabled() != Some(true) {
        return false;
    }
    if !enable() {
        return false;
    }
    persist_state(AUTOSTART_MIGRATION_COMPLETE)
}

pub(crate) fn migrate_autostart_entry_if_pending(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    if is_flatpak() {
        return;
    }
    #[cfg(target_os = "windows")]
    if is_windows_store_install() {
        return;
    }
    let mut config = read_config(app);
    let already_migrated = bool_setting_enabled(config.autostart_startup_flag_migrated.as_deref());
    let autostart = app.autolaunch();
    let config_path = get_config_path(app);
    let secrets_path = get_secrets_path(app);
    let _ = migrate_autostart_entry_with(
        already_migrated,
        || autostart.is_enabled().ok(),
        || autostart.enable().is_ok(),
        |value| {
            config.autostart_startup_flag_migrated = Some(value.to_string());
            write_config_files(&config_path, &secrets_path, &config).is_ok()
        },
    );
}

#[cfg(any(target_os = "linux", test))]
fn flatpak_background_autostart_command() -> [&'static str; 2] {
    ["mindwtr", "--startup"]
}

#[cfg(target_os = "linux")]
async fn set_flatpak_launch_at_startup_enabled(enabled: bool) -> Result<bool, String> {
    use ashpd::desktop::background::Background;

    let response = Background::request()
        .reason("Keep reminders and sync running when Mindwtr is in the background")
        .auto_start(enabled)
        .dbus_activatable(false)
        .command(flatpak_background_autostart_command())
        .send()
        .await
        .map_err(|error| error.to_string())?
        .response()
        .map_err(|error| error.to_string())?;

    Ok(response.auto_start())
}

#[cfg(target_os = "windows")]
fn store_startup_task() -> Result<windows::ApplicationModel::StartupTask, String> {
    use windows::core::HSTRING;

    windows::ApplicationModel::StartupTask::GetAsync(&HSTRING::from(STORE_STARTUP_TASK_ID))
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn store_startup_state_is_enabled(state: windows::ApplicationModel::StartupTaskState) -> bool {
    use windows::ApplicationModel::StartupTaskState;

    state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy
}

#[cfg(target_os = "windows")]
async fn get_store_launch_at_startup_enabled() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let task = store_startup_task()?;
        let state = task.State().map_err(|error| error.to_string())?;
        Ok(store_startup_state_is_enabled(state))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(target_os = "windows")]
async fn set_store_launch_at_startup_enabled(enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use windows::ApplicationModel::StartupTaskState;

        let task = store_startup_task()?;
        if !enabled {
            task.Disable().map_err(|error| error.to_string())?;
            return Ok(false);
        }
        let state = task
            .RequestEnableAsync()
            .map_err(|error| error.to_string())?
            .get()
            .map_err(|error| error.to_string())?;


        if state == StartupTaskState::DisabledByUser {
            return Err(
                "Startup for Mindwtr is turned off in Windows. Enable it under Settings > Apps > Startup, then try again.".to_string(),
            );
        }
        if state == StartupTaskState::DisabledByPolicy {
            return Err("Startup is disabled by system policy on this device.".to_string());
        }
        Ok(store_startup_state_is_enabled(state))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_never_turns_on_an_entry_that_was_already_disabled() {
        let completed = migrate_autostart_entry_with(
            false,
            || Some(false),
            || panic!("disabled entry must not be enabled"),
            |_| panic!("disabled entry must not start a migration"),
        );

        assert!(!completed);
    }

    #[test]
    fn migration_retries_after_enable_failure_without_disabling_the_entry() {
        let mut enable_calls = 0;
        let mut persisted = Vec::new();
        let first_completed = migrate_autostart_entry_with(
            false,
            || Some(true),
            || {
                enable_calls += 1;
                false
            },
            |value| {
                persisted.push(value);
                true
            },
        );

        assert!(!first_completed);
        assert_eq!(enable_calls, 1);
        assert!(persisted.is_empty());

        let mut retry_enable_calls = 0;
        let mut retry_persisted = Vec::new();
        let retry_completed = migrate_autostart_entry_with(
            false,
            || Some(true),
            || {
                retry_enable_calls += 1;
                true
            },
            |value| {
                retry_persisted.push(value);
                true
            },
        );

        assert!(retry_completed);
        assert_eq!(retry_enable_calls, 1);
        assert_eq!(retry_persisted, [AUTOSTART_MIGRATION_COMPLETE]);
    }

    #[test]
    fn migration_marks_complete_only_after_enable_succeeds() {
        let mut enable_calls = 0;
        let completed = migrate_autostart_entry_with(
            false,
            || Some(true),
            || {
                enable_calls += 1;
                true
            },
            |_| false,
        );

        assert!(!completed);
        assert_eq!(enable_calls, 1);
    }

    #[test]
    fn flatpak_background_autostart_runs_the_app_with_startup_semantics() {
        assert_eq!(
            flatpak_background_autostart_command(),
            ["mindwtr", "--startup"]
        );
    }
}
