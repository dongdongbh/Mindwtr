use crate::*;

#[cfg(target_os = "macos")]
use std::sync::OnceLock;

#[cfg(target_os = "macos")]
const MACOS_WIDGET_APP_GROUP: &str = env!("MINDWTR_MACOS_APP_GROUP");
#[cfg(target_os = "macos")]
const MACOS_WIDGET_PAYLOAD_FILE_NAME: &str = "widget-payload.json";
#[cfg(target_os = "macos")]
static MACOS_WIDGET_CAPTURE_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(target_os = "macos")]
type MacosWidgetCaptureCallback = extern "C" fn();

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn mindwtr_macos_widget_container_path(app_group: *const c_char) -> *mut c_char;
    fn mindwtr_macos_widget_free_string(ptr: *mut c_char);
    fn mindwtr_macos_install_widget_capture_listener(
        app_group: *const c_char,
        callback: MacosWidgetCaptureCallback,
    ) -> bool;
    fn mindwtr_reload_widgets();
}

#[cfg(target_os = "macos")]
extern "C" fn handle_macos_widget_capture_request() {
    let Some(app) = MACOS_WIDGET_CAPTURE_APP_HANDLE.get() else {
        log::warn!("macOS widget capture request arrived before host listener setup");
        return;
    };

    log::info!(
        "macOS widget capture request delivered to host \
         extra.releaseCheck=v1.3.0/macos-widget-capture"
    );
    crate::ui::show_macos_widget_quick_add_window(app);
}

pub(crate) fn install_macos_widget_capture_listener(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if MACOS_WIDGET_CAPTURE_APP_HANDLE.get().is_some() {
            return;
        }
        if MACOS_WIDGET_CAPTURE_APP_HANDLE.set(app.clone()).is_err() {
            return;
        }

        let Ok(app_group) = CString::new(MACOS_WIDGET_APP_GROUP) else {
            log::warn!("macOS widget capture listener: invalid App Group identifier");
            return;
        };
        let installed = unsafe {
            mindwtr_macos_install_widget_capture_listener(
                app_group.as_ptr(),
                handle_macos_widget_capture_request,
            )
        };
        if !installed {
            log::warn!("macOS widget capture listener could not be installed");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

#[cfg(target_os = "macos")]
fn macos_widget_container_dir() -> Option<PathBuf> {
    let group_cstring = CString::new(MACOS_WIDGET_APP_GROUP).ok()?;
    let raw = unsafe { mindwtr_macos_widget_container_path(group_cstring.as_ptr()) };
    if raw.is_null() {
        return None;
    }

    let path = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    unsafe { mindwtr_macos_widget_free_string(raw) };
    Some(PathBuf::from(path))
}

#[tauri::command(async)]
pub(crate) fn write_macos_widget_payload(payload_json: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let Some(dir) = macos_widget_container_dir() else {
            log::warn!("macOS widget: App Group container unavailable; skipping payload write");
            return Ok(());
        };
        if let Err(error) = fs::create_dir_all(&dir) {
            log::warn!("macOS widget: failed to create container dir: {error}");
            return Ok(());
        }
        let final_path = dir.join(MACOS_WIDGET_PAYLOAD_FILE_NAME);
        let tmp_path = dir.join(format!("{MACOS_WIDGET_PAYLOAD_FILE_NAME}.tmp"));
        if let Err(error) = fs::write(&tmp_path, payload_json.as_bytes()) {
            log::warn!("macOS widget: failed to write payload: {error}");
            return Ok(());
        }

        if let Err(error) = fs::rename(&tmp_path, &final_path) {
            log::warn!("macOS widget: failed to publish payload: {error}");
            return Ok(());
        }
        unsafe { mindwtr_reload_widgets() };
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = payload_json;
        Ok(())
    }
}
