use crate::*;

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow},
};

const QUIT_WATCHDOG_SECONDS: u64 = 5;
const QUICK_ADD_WINDOW_WIDTH: f64 = 620.0;
const QUICK_ADD_WINDOW_HEIGHT: f64 = 420.0;
const GNOME_INTERFACE_SCHEMA: &str = "org.gnome.desktop.interface";
const GNOME_COLOR_SCHEME_KEY: &str = "color-scheme";
const GNOME_GTK_THEME_KEY: &str = "gtk-theme";

/// macOS is deliberately absent: the quick-add window is a non-activating
/// panel, so Mindwtr never becomes the active app and the app the user was in
/// stays frontmost the whole time. Re-activating it on close would at best be a
/// no-op and at worst steal focus from an app the user switched to while the
/// panel was open (#794).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum QuickAddFocusPolicy {
    RestoreWindowsForegroundWindow,
    None,
}

fn quick_add_focus_policy_for_os(os: &str) -> QuickAddFocusPolicy {
    match os {
        "windows" => QuickAddFocusPolicy::RestoreWindowsForegroundWindow,
        _ => QuickAddFocusPolicy::None,
    }
}

fn current_quick_add_focus_policy() -> QuickAddFocusPolicy {
    quick_add_focus_policy_for_os(std::env::consts::OS)
}

#[cfg(target_os = "windows")]
fn webview_window_hwnd(window: &tauri::WebviewWindow) -> Option<isize> {
    window.hwnd().ok().map(|hwnd| hwnd.0 as isize)
}

#[cfg(target_os = "windows")]
fn capture_windows_previous_foreground_hwnd(window: &tauri::WebviewWindow) -> Option<isize> {
    let foreground = unsafe { GetForegroundWindow() } as isize;
    if foreground == 0 || Some(foreground) == webview_window_hwnd(window) {
        return None;
    }
    Some(foreground)
}

#[cfg(not(target_os = "windows"))]
fn capture_windows_previous_foreground_hwnd(_window: &tauri::WebviewWindow) -> Option<isize> {
    None
}

fn capture_quick_add_focus_snapshot(window: &tauri::WebviewWindow) -> QuickAddFocusSnapshot {
    match current_quick_add_focus_policy() {
        QuickAddFocusPolicy::RestoreWindowsForegroundWindow => QuickAddFocusSnapshot {
            windows_hwnd: capture_windows_previous_foreground_hwnd(window),
        },
        QuickAddFocusPolicy::None => QuickAddFocusSnapshot::default(),
    }
}

fn remember_quick_add_focus(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let snapshot = capture_quick_add_focus_snapshot(window);
    let state = app.state::<QuickAddFocusState>();
    if let Ok(mut guard) = state.0.lock() {
        *guard = snapshot;
    };
}

fn take_quick_add_focus_snapshot(app: &tauri::AppHandle) -> QuickAddFocusSnapshot {
    let state = app.state::<QuickAddFocusState>();
    let Ok(mut guard) = state.0.lock() else {
        return QuickAddFocusSnapshot::default();
    };
    let snapshot = *guard;
    *guard = QuickAddFocusSnapshot::default();
    snapshot
}

#[cfg(target_os = "windows")]
fn restore_windows_foreground_window(hwnd: isize) {
    if hwnd != 0 {
        unsafe {
            let _ = SetForegroundWindow(hwnd as HWND);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn restore_windows_foreground_window(_hwnd: isize) {}

fn restore_quick_add_focus(snapshot: QuickAddFocusSnapshot) {
    match current_quick_add_focus_policy() {
        QuickAddFocusPolicy::RestoreWindowsForegroundWindow => {
            if let Some(hwnd) = snapshot.windows_hwnd {
                restore_windows_foreground_window(hwnd);
            }
        }
        QuickAddFocusPolicy::None => {}
    }
}

fn normalize_gsettings_output(value: &str) -> String {
    value
        .trim()
        .trim_matches('\'')
        .trim_matches('"')
        .trim()
        .to_ascii_lowercase()
}

fn parse_gnome_color_scheme(value: &str) -> Option<&'static str> {
    match normalize_gsettings_output(value).as_str() {
        "prefer-dark" => Some("dark"),
        "default" | "prefer-light" => Some("light"),
        _ => None,
    }
}

fn parse_gnome_gtk_theme(value: &str) -> Option<&'static str> {
    let normalized = normalize_gsettings_output(value);
    if normalized.contains("dark") {
        Some("dark")
    } else if normalized.is_empty() {
        None
    } else {
        Some("light")
    }
}

fn resolve_gnome_system_theme_preference(
    color_scheme: Option<&str>,
    gtk_theme: Option<&str>,
) -> Option<&'static str> {
    color_scheme
        .and_then(parse_gnome_color_scheme)
        .or_else(|| gtk_theme.and_then(parse_gnome_gtk_theme))
}

#[cfg(target_os = "linux")]
fn read_gsettings_value(schema: &str, key: &str) -> Option<String> {
    let output = Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(not(target_os = "linux"))]
fn read_gsettings_value(_schema: &str, _key: &str) -> Option<String> {
    None
}

// KDE never writes GNOME's gsettings keys, so `color-scheme` reads 'default'
// and this probe reports "light" on a dark Plasma desktop (#989).
fn is_kde_desktop_value(value: &str) -> bool {
    value
        .to_ascii_lowercase()
        .split(':')
        .any(|part| part == "kde" || part == "plasma")
}

fn is_kde_desktop() -> bool {
    ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP"]
        .iter()
        .any(|var| std::env::var(var).is_ok_and(|value| is_kde_desktop_value(&value)))
}

// The XDG desktop portal's appearance setting is the one cross-desktop dark
// signal (1 = prefer dark, 2 = prefer light, 0 = no preference). Silencing
// this probe on KDE and trusting WebKitGTK's own media query was not enough:
// kde-gtk-config does not reliably propagate Plasma's dark scheme into the
// GTK settings WebKitGTK reads, so the app still started light on a dark
// Plasma desktop (#989).
fn parse_portal_color_scheme(output: &str) -> Option<&'static str> {
    // gdbus prints `(<uint32 1>,)` for ReadOne and `(<<uint32 1>>,)` for Read.
    let rest = output.split("uint32").nth(1)?;
    let digits: String = rest
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    match digits.parse::<u32>().ok()? {
        1 => Some("dark"),
        2 => Some("light"),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn read_portal_color_scheme() -> Option<&'static str> {
    // ReadOne first (current portals), Read as the legacy spelling.
    for method in ["ReadOne", "Read"] {
        let output = Command::new("gdbus")
            .args([
                "call",
                "--session",
                "--dest",
                "org.freedesktop.portal.Desktop",
                "--object-path",
                "/org/freedesktop/portal/desktop",
                "--method",
                &format!("org.freedesktop.portal.Settings.{method}"),
                "org.freedesktop.appearance",
                "color-scheme",
            ])
            .output();
        let Ok(output) = output else { return None };
        if !output.status.success() {
            continue;
        }
        if let Some(preference) = std::str::from_utf8(&output.stdout)
            .ok()
            .and_then(parse_portal_color_scheme)
        {
            return Some(preference);
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn read_portal_color_scheme() -> Option<&'static str> {
    None
}

// Fallback for KDE sessions without a working settings portal: Plasma writes
// the active color scheme's name into kdeglobals. Only a "dark"-named scheme
// is trusted — a name without "dark" proves nothing, and forcing light from a
// name heuristic is exactly the failure mode this probe once had on GNOME.
fn parse_kde_color_scheme(contents: &str) -> Option<String> {
    let mut in_general = false;
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_general = line == "[General]";
            continue;
        }
        if !in_general {
            continue;
        }
        if let Some(value) = line.strip_prefix("ColorScheme=") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn kde_dark_hint_from_scheme(scheme: Option<&str>) -> Option<&'static str> {
    scheme
        .filter(|value| value.to_ascii_lowercase().contains("dark"))
        .map(|_| "dark")
}

#[cfg(target_os = "linux")]
fn read_kde_color_scheme_preference() -> Option<&'static str> {
    let config_dir = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|home| std::path::PathBuf::from(home).join(".config"))
        })?;
    let contents = std::fs::read_to_string(config_dir.join("kdeglobals")).ok()?;
    kde_dark_hint_from_scheme(parse_kde_color_scheme(&contents).as_deref())
}

#[cfg(not(target_os = "linux"))]
fn read_kde_color_scheme_preference() -> Option<&'static str> {
    None
}

// Spawns and waits on `gdbus`/`gsettings` and may read kdeglobals — real
// process and file I/O, no shared state to race (B1).
#[tauri::command(async)]
pub(crate) fn get_system_theme_preference() -> Option<String> {
    if let Some(preference) = read_portal_color_scheme() {
        return Some(preference.to_string());
    }
    if is_kde_desktop() {
        return read_kde_color_scheme_preference().map(str::to_string);
    }
    let color_scheme = read_gsettings_value(GNOME_INTERFACE_SCHEMA, GNOME_COLOR_SCHEME_KEY);
    let gtk_theme = read_gsettings_value(GNOME_INTERFACE_SCHEMA, GNOME_GTK_THEME_KEY);
    resolve_gnome_system_theme_preference(color_scheme.as_deref(), gtk_theme.as_deref())
        .map(str::to_string)
}

#[tauri::command]
pub(crate) fn consume_quick_add_pending(
    state: tauri::State<'_, QuickAddPending>,
    target: Option<String>,
) -> bool {
    let requested_target = target.as_deref();
    let Ok(mut pending_target) = state.0.lock() else {
        return false;
    };
    let Some(current_target) = pending_target.as_deref() else {
        return false;
    };
    if requested_target.is_some_and(|target| target != current_target) {
        return false;
    }
    *pending_target = None;
    true
}

#[tauri::command]
pub(crate) fn acknowledge_close_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, CloseRequestHandled>,
) {
    crate::logging::append_native_log_line(
        &app,
        "Close trace: acknowledge_close_request command invoked",
    );
    state.0.store(true, Ordering::SeqCst);
}

fn normalize_global_quick_add_shortcut(shortcut: Option<&str>) -> Result<Option<String>, String> {
    let trimmed = shortcut.map(str::trim).unwrap_or("");
    if trimmed.is_empty() {
        return Ok(Some(default_global_quick_add_shortcut().to_string()));
    }

    if trimmed.eq_ignore_ascii_case(GLOBAL_QUICK_ADD_SHORTCUT_DISABLED) {
        return Ok(None);
    }

    if trimmed == GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT
        || trimmed == GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N
        || trimmed == GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q
        || trimmed == GLOBAL_QUICK_ADD_SHORTCUT_LEGACY
    {
        return Ok(Some(trimmed.to_string()));
    }

    Err("Unsupported quick add shortcut".to_string())
}

pub(crate) fn apply_global_quick_add_shortcut(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, GlobalQuickAddShortcutState>,
    shortcut: Option<&str>,
) -> Result<String, String> {
    let normalized = normalize_global_quick_add_shortcut(shortcut)?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Shortcut state lock poisoned".to_string())?;

    if *guard == normalized {
        return Ok(guard
            .clone()
            .unwrap_or_else(|| GLOBAL_QUICK_ADD_SHORTCUT_DISABLED.to_string()));
    }

    if let Some(existing) = guard.as_ref() {
        if let Err(error) = app.global_shortcut().unregister(existing.as_str()) {
            log::warn!("Failed to unregister existing quick add shortcut: {error}");
        }
    }

    if let Some(next_shortcut) = normalized.as_ref() {
        app.global_shortcut()
            .on_shortcut(next_shortcut.as_str(), move |app, _shortcut, _event| {
                show_quick_add_window(app);
            })
            .map_err(|error| format!("Failed to register global quick add shortcut: {error}"))?;
    }

    *guard = normalized.clone();
    Ok(normalized.unwrap_or_else(|| GLOBAL_QUICK_ADD_SHORTCUT_DISABLED.to_string()))
}

#[tauri::command]
pub(crate) fn set_global_quick_add_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, GlobalQuickAddShortcutState>,
    shortcut: Option<String>,
) -> Result<GlobalQuickAddShortcutApplyResult, String> {
    #[cfg(target_os = "linux")]
    if is_flatpak() {
        let disabled = apply_global_quick_add_shortcut(
            &app,
            &state,
            Some(GLOBAL_QUICK_ADD_SHORTCUT_DISABLED),
        )?;
        let requested_shortcut = shortcut.as_deref().unwrap_or("");
        let warning = if requested_shortcut.is_empty()
            || requested_shortcut.eq_ignore_ascii_case(GLOBAL_QUICK_ADD_SHORTCUT_DISABLED)
        {
            None
        } else {
            Some(
                "Flatpak/Wayland requires a desktop custom shortcut. Use: flatpak run tech.dongdongbh.mindwtr --quick-add"
                    .to_string(),
            )
        };
        return Ok(GlobalQuickAddShortcutApplyResult {
            shortcut: disabled,
            warning,
        });
    }

    match apply_global_quick_add_shortcut(&app, &state, shortcut.as_deref()) {
        Ok(applied) => Ok(GlobalQuickAddShortcutApplyResult {
            shortcut: applied,
            warning: None,
        }),
        Err(error) => {
            log::warn!(
                "Failed to apply global quick add shortcut; falling back to disabled: {error}"
            );
            let disabled = apply_global_quick_add_shortcut(
                &app,
                &state,
                Some(GLOBAL_QUICK_ADD_SHORTCUT_DISABLED),
            )?;
            Ok(GlobalQuickAddShortcutApplyResult {
                shortcut: disabled,
                warning: Some(
                    "Global quick add shortcut is unavailable (likely already used by another app), so it was disabled."
                        .to_string(),
                ),
            })
        }
    }
}

#[tauri::command]
pub(crate) fn quit_app(app: tauri::AppHandle) {
    // Close trace (#913): confirms the quit command reached native code; if
    // the process survives past this line, app.exit itself failed to exit.
    crate::logging::append_native_log_line(
        &app,
        "Close trace: quit_app command invoked, calling app.exit(0)",
    );
    app.exit(0);
    // app.exit only asks the event loop to exit and returns straight away, so a
    // line logged right here printed on every healthy quit and read like a
    // failure in shared logs (#913). Report only if the process is genuinely
    // still alive well after the request; this thread dies with the process
    // when the exit works, so a clean quit stays silent.
    let watchdog_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(QUIT_WATCHDOG_SECONDS));
        crate::logging::append_native_log_line(
            &watchdog_app,
            "Close trace: still running after app.exit(0); the exit did not terminate the process",
        );
    });
}

#[tauri::command]
pub(crate) fn set_tray_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(visible).map_err(|e| e.to_string())
    } else {
        log::warn!("set_tray_visible called but no tray icon exists");
        Ok(())
    }
}

/// Sets the hover text on the tray icon, used to surface today's Focus (#935).
///
/// Linux is a deliberate no-op: Tauri lists tray tooltips as unsupported there,
/// so the call would just error on every Focus change. The frontend still sends
/// the update rather than branching per platform.
#[tauri::command]
pub(crate) fn set_tray_tooltip(
    app: tauri::AppHandle,
    tooltip: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = (&app, &tooltip);
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let Some(tray) = app.tray_by_id("main") else {
            return Ok(());
        };
        tray.set_tooltip(tooltip.as_deref())
            .map_err(|e| e.to_string())
    }
}

/// How long the first reveal waits for the UI before showing the window anyway.
/// A frontend that throws before it can call notify_ui_ready must never leave
/// the user with no window (#936).
const MAIN_WINDOW_REVEAL_TIMEOUT_SECONDS: u64 = 4;

/// Gates the first show of the main window, which is built hidden so the
/// restored geometry and the first paint land off screen (#936).
#[derive(Default)]
pub(crate) struct MainWindowReveal {
    /// This launch is meant to stay hidden — start in tray (#928), or a global
    /// quick-add hotkey launch. The UI still signals ready; it just must not
    /// pull the main window up.
    suppressed: AtomicBool,
    shown: AtomicBool,
}

impl MainWindowReveal {
    pub(crate) fn suppress(&self) {
        self.suppressed.store(true, Ordering::SeqCst);
    }
}

/// Shows the main window once. Later calls are no-ops, so the UI-ready signal
/// and the timeout backstop can both fire without fighting each other, and
/// neither can re-show a window the user has since closed to the tray.
pub(crate) fn reveal_main_window(app: &tauri::AppHandle) {
    let state = app.state::<MainWindowReveal>();
    if state.suppressed.load(Ordering::SeqCst) {
        return;
    }
    if state.shown.swap(true, Ordering::SeqCst) {
        return;
    }
    show_main(app);
}

/// Called by the main window's frontend once React has painted its first frame.
#[tauri::command]
pub(crate) fn notify_ui_ready(app: tauri::AppHandle) {
    reveal_main_window(&app);
}

pub(crate) fn reveal_main_window_after_timeout(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(MAIN_WINDOW_REVEAL_TIMEOUT_SECONDS));
        let _ = handle
            .clone()
            .run_on_main_thread(move || reveal_main_window(&handle));
    });
}

/// tao < 0.36 installs its own Wayland CSD titlebar whose buttons stop
/// responding after any hide -> show cycle (tauri-apps/tauri#11856; fixed
/// upstream by tao#1218, released in tao 0.36.0, not yet in a published
/// Tauri). Toggling resizable makes tao's WlHeader rebuild its buttons
/// (it listens on resizable-notify) with no visible change. Skipped while
/// maximized — maximizing already re-allocates the titlebar. Delete once
/// our Tauri ships tao >= 0.36. (#988)
#[cfg(target_os = "linux")]
pub(crate) fn nudge_wayland_csd_after_show(window: &tauri::WebviewWindow) {
    if std::env::var("WAYLAND_DISPLAY").is_err() {
        return;
    }
    if window.is_maximized().unwrap_or(false) {
        return;
    }
    let _ = window.set_resizable(false);
    let _ = window.set_resizable(true);
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn nudge_wayland_csd_after_show(_window: &tauri::WebviewWindow) {}

/// The single funnel for putting the main window back on screen: the tray menu
/// and tray click, a second instance (including the Flatpak listener), the
/// first reveal after launch, and the quick-add fallback all land here.
///
/// The macOS activation policy is restored to Regular before the window
/// appears — never after — so the window is never on screen while the app is
/// still an accessory (no Dock icon, no Cmd+Tab, and the menu bar left with
/// the previously frontmost app). `set_focus` below then activates the app,
/// which is what actually hands the menu bar over.
pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = crate::platform::apply_macos_activation_policy(app, false);
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        nudge_wayland_csd_after_show(&window);
        let _ = window.set_focus();
    }
}

pub(crate) fn show_main_and_emit(app: &tauri::AppHandle) {
    show_main(app);
    if let Ok(mut pending_target) = app.state::<QuickAddPending>().0.lock() {
        *pending_target = Some(QUICK_ADD_TARGET_MAIN.to_string());
    }
    let payload = QuickAddEventPayload {
        target: QUICK_ADD_TARGET_MAIN.to_string(),
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("quick-add", payload);
    } else {
        let _ = app.emit("quick-add", payload);
    }
}

/// Turns the freshly built quick-add window into a non-activating panel so it
/// can take the keyboard without activating Mindwtr (#794). Done once at
/// creation, not per show, so the very first hotkey press already behaves.
#[cfg(target_os = "macos")]
fn convert_quick_add_window_to_panel(window: &tauri::WebviewWindow) {
    let converted = window
        .ns_window()
        .ok()
        .is_some_and(|ns_window| unsafe { mindwtr_macos_make_quick_add_panel(ns_window) });
    if !converted {
        log::warn!(
            "Quick add window could not become a non-activating panel; \
             falling back to the activating focus path."
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn convert_quick_add_window_to_panel(_window: &tauri::WebviewWindow) {}

/// Orders the panel front and gives it the keyboard without activating the app.
/// False means the window is not a panel (every non-macOS platform, or a failed
/// conversion), and the caller must fall back to `set_focus`.
#[cfg(target_os = "macos")]
fn present_quick_add_panel(window: &tauri::WebviewWindow) -> bool {
    window
        .ns_window()
        .ok()
        .is_some_and(|ns_window| unsafe { mindwtr_macos_present_quick_add_panel(ns_window) })
}

#[cfg(not(target_os = "macos"))]
fn present_quick_add_panel(_window: &tauri::WebviewWindow) -> bool {
    false
}

/// `set_focus` activates the app on macOS, which is exactly what drags the main
/// window forward (#794) — so the panel path must not call it. Anywhere else,
/// and whenever the panel conversion failed, the call stays: without it the
/// window is on screen but cannot be typed into.
fn quick_add_show_needs_focus_call(os: &str, panel_presented: bool) -> bool {
    !(os == "macos" && panel_presented)
}

pub(crate) fn create_quick_add_window(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(QUICK_ADD_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        QUICK_ADD_WINDOW_LABEL,
        tauri::WebviewUrl::App(QUICK_ADD_WINDOW_URL.into()),
    );
    // Portable mode keeps every webview profile inside the portable dir (#855).
    if let Some(webview_dir) = crate::storage::portable_webview_data_dir() {
        let _ = std::fs::create_dir_all(&webview_dir);
        builder = builder.data_directory(webview_dir);
    }
    builder
        .title("Quick Add")
        .inner_size(QUICK_ADD_WINDOW_WIDTH, QUICK_ADD_WINDOW_HEIGHT)
        .resizable(false)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map(|window| {
            crate::allow_webview_clipboard_read(&window);
            convert_quick_add_window_to_panel(&window)
        })
        .map_err(|error| format!("Failed to create quick add window: {error}"))
}

fn quick_add_window_physical_size(scale_factor: f64) -> tauri::PhysicalSize<u32> {
    tauri::LogicalSize::new(QUICK_ADD_WINDOW_WIDTH, QUICK_ADD_WINDOW_HEIGHT)
        .to_physical(scale_factor)
}

fn centered_quick_add_position(
    work_area: &tauri::PhysicalRect<i32, u32>,
    window_size: &tauri::PhysicalSize<u32>,
) -> tauri::PhysicalPosition<i32> {
    let x_offset = work_area.size.width.saturating_sub(window_size.width) / 2;
    let y_offset = work_area.size.height.saturating_sub(window_size.height) / 2;
    tauri::PhysicalPosition::new(
        work_area.position.x + x_offset as i32,
        work_area.position.y + y_offset as i32,
    )
}

fn quick_add_target_monitor(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Option<tauri::Monitor> {
    app.cursor_position()
        .ok()
        .and_then(|position| {
            app.monitor_from_point(position.x, position.y)
                .ok()
                .flatten()
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn center_quick_add_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Some(monitor) = quick_add_target_monitor(app, window) else {
        if let Err(error) = window.center() {
            log::warn!("Failed to center quick add window: {error}");
        }
        return;
    };
    let window_size = quick_add_window_physical_size(monitor.scale_factor());
    let position = centered_quick_add_position(monitor.work_area(), &window_size);
    if let Err(error) = window.set_position(position) {
        log::warn!("Failed to position quick add window: {error}");
    }
}

pub(crate) fn hide_quick_add_window_for_app(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(QUICK_ADD_WINDOW_LABEL) {
        window
            .hide()
            .map_err(|error| format!("Failed to hide quick add window: {error}"))?;
    }
    let snapshot = take_quick_add_focus_snapshot(app);
    restore_quick_add_focus(snapshot);
    Ok(())
}

#[tauri::command]
pub(crate) fn hide_quick_add_window(app: tauri::AppHandle) -> Result<(), String> {
    hide_quick_add_window_for_app(&app)
}

pub(crate) fn show_quick_add_window(app: &tauri::AppHandle) {
    if let Ok(mut pending_target) = app.state::<QuickAddPending>().0.lock() {
        *pending_target = Some(QUICK_ADD_TARGET_WINDOW.to_string());
    }

    if let Some(window) = app.get_webview_window(QUICK_ADD_WINDOW_LABEL) {
        remember_quick_add_focus(app, &window);
        let _ = window.set_skip_taskbar(true);
        let _ = window.unminimize();
        center_quick_add_window(app, &window);
        let _ = window.show();
        let panel_presented = present_quick_add_panel(&window);
        if quick_add_show_needs_focus_call(std::env::consts::OS, panel_presented) {
            let _ = window.set_focus();
        }
        let payload = QuickAddEventPayload {
            target: QUICK_ADD_TARGET_WINDOW.to_string(),
        };
        let _ = window.emit("quick-add", payload);
        return;
    }

    log::warn!("Quick add window unavailable; falling back to the main window.");
    show_main_and_emit(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gnome_color_scheme_values() {
        assert_eq!(parse_gnome_color_scheme("'prefer-dark'"), Some("dark"));
        assert_eq!(parse_gnome_color_scheme("'prefer-light'"), Some("light"));
        assert_eq!(parse_gnome_color_scheme("'default'"), Some("light"));
        assert_eq!(parse_gnome_color_scheme("'unknown'"), None);
    }

    #[test]
    fn falls_back_to_gtk_theme_when_color_scheme_is_missing() {
        assert_eq!(
            resolve_gnome_system_theme_preference(None, Some("'Adwaita-dark'")),
            Some("dark")
        );
        assert_eq!(
            resolve_gnome_system_theme_preference(None, Some("'Adwaita'")),
            Some("light")
        );
    }

    #[test]
    fn prefers_color_scheme_over_gtk_theme() {
        assert_eq!(
            resolve_gnome_system_theme_preference(Some("'prefer-dark'"), Some("'Adwaita'")),
            Some("dark")
        );
    }

    #[test]
    fn detects_kde_desktop_values() {
        assert!(is_kde_desktop_value("KDE"));
        assert!(is_kde_desktop_value("plasma"));
        assert!(is_kde_desktop_value("ubuntu:KDE"));
        assert!(!is_kde_desktop_value("GNOME"));
        assert!(!is_kde_desktop_value("niri"));
        assert!(!is_kde_desktop_value("kde-something"));
        assert!(!is_kde_desktop_value(""));
    }

    #[test]
    fn parses_portal_color_scheme_replies() {
        assert_eq!(parse_portal_color_scheme("(<uint32 1>,)"), Some("dark"));
        assert_eq!(parse_portal_color_scheme("(<<uint32 1>>,)"), Some("dark"));
        assert_eq!(parse_portal_color_scheme("(<uint32 2>,)"), Some("light"));
        assert_eq!(parse_portal_color_scheme("(<uint32 0>,)"), None);
        assert_eq!(parse_portal_color_scheme("(<uint32 7>,)"), None);
        assert_eq!(parse_portal_color_scheme(""), None);
        assert_eq!(parse_portal_color_scheme("uint32"), None);
    }

    #[test]
    fn parses_kde_color_scheme_from_kdeglobals() {
        let contents = "[Icons]\nTheme=breeze\n\n[General]\nColorScheme=BreezeDark\nName=x\n";
        assert_eq!(
            parse_kde_color_scheme(contents).as_deref(),
            Some("BreezeDark")
        );
        // The key outside [General] must not match.
        let misplaced = "[KDE]\nColorScheme=BreezeDark\n[General]\nName=x\n";
        assert_eq!(parse_kde_color_scheme(misplaced), None);
        assert_eq!(parse_kde_color_scheme(""), None);
    }

    #[test]
    fn kde_scheme_names_only_ever_report_dark() {
        assert_eq!(kde_dark_hint_from_scheme(Some("BreezeDark")), Some("dark"));
        assert_eq!(kde_dark_hint_from_scheme(Some("Fedora Dark")), Some("dark"));
        // A non-dark name proves nothing; never force light from a name.
        assert_eq!(kde_dark_hint_from_scheme(Some("Breeze")), None);
        assert_eq!(kde_dark_hint_from_scheme(None), None);
    }

    #[test]
    fn centered_quick_add_position_uses_monitor_work_area() {
        let work_area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(100, -20),
            size: tauri::PhysicalSize::new(1200, 800),
        };
        let window_size = tauri::PhysicalSize::new(620, 420);

        assert_eq!(
            centered_quick_add_position(&work_area, &window_size),
            tauri::PhysicalPosition::new(390, 170)
        );
    }

    #[test]
    fn centered_quick_add_position_clamps_to_work_area_when_window_is_larger() {
        let work_area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(-1280, 0),
            size: tauri::PhysicalSize::new(500, 300),
        };
        let window_size = tauri::PhysicalSize::new(620, 420);

        assert_eq!(
            centered_quick_add_position(&work_area, &window_size),
            tauri::PhysicalPosition::new(-1280, 0)
        );
    }

    #[test]
    fn quick_add_window_physical_size_uses_monitor_scale_factor() {
        assert_eq!(
            quick_add_window_physical_size(2.0),
            tauri::PhysicalSize::new(1240, 840)
        );
    }

    #[test]
    fn quick_add_focus_policy_is_platform_specific() {
        // The macOS panel never takes activation away, so nothing is restored
        // on close — restoring would be the thing that steals focus (#794).
        assert_eq!(
            quick_add_focus_policy_for_os("macos"),
            QuickAddFocusPolicy::None
        );
        assert_eq!(
            quick_add_focus_policy_for_os("windows"),
            QuickAddFocusPolicy::RestoreWindowsForegroundWindow
        );
        assert_eq!(
            quick_add_focus_policy_for_os("linux"),
            QuickAddFocusPolicy::None
        );
        assert_eq!(
            quick_add_focus_policy_for_os("freebsd"),
            QuickAddFocusPolicy::None
        );
    }

    #[test]
    fn macos_panel_show_skips_the_activating_focus_call() {
        assert!(!quick_add_show_needs_focus_call("macos", true));
        // Conversion failed: better a focused main window than a popup that
        // swallows every keystroke.
        assert!(quick_add_show_needs_focus_call("macos", false));
    }

    #[test]
    fn other_platforms_always_keep_the_focus_call() {
        for os in ["windows", "linux", "freebsd"] {
            assert!(quick_add_show_needs_focus_call(os, false));
            assert!(quick_add_show_needs_focus_call(os, true));
        }
    }
}
