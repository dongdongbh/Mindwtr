//! Desktop privacy lock (#1472): Windows Hello on Windows, Touch ID or the
//! account password on macOS. Linux has no device check that works across
//! deb/AppImage/Flatpak, so it reports `supported: false` and the setting hides.
//!
//! The lock settings live in the device-level `config.toml`, never in the
//! per-library database, so switching libraries can never skip the lock. All
//! access goes through `read_app_lock_config` / `write_app_lock_config`.
//!
//! The in-process lock flag lives here too, so the tray and the Quick Add
//! window can refuse to show task text without asking the renderer.

use crate::*;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8};

/// Minutes away before the lock engages; same choices as mobile App Lock.
const RELOCK_DELAY_OPTIONS: [u8; 4] = [0, 1, 5, 15];
// Linux has no tray tooltip (Tauri does not support one there).
#[cfg_attr(target_os = "linux", allow(dead_code))]
const NEUTRAL_TRAY_TOOLTIP: &str = "Mindwtr";

static ENABLED: AtomicBool = AtomicBool::new(false);
static LOCKED: AtomicBool = AtomicBool::new(false);
static RELOCK_DELAY: AtomicU8 = AtomicU8::new(0);
static AWAY: AwayLock = AwayLock::new();

/// Delay 0 still waits this long: focus moving to the Quick Add window or a
/// dialog arrives as "lost" then "gained".
const AWAY_GRACE: Duration = Duration::from_millis(400);

/// The away lock's state, shared by every window: whether any Mindwtr window
/// has focus, how many Mindwtr-owned dialogs or OS prompts are open, and a
/// generation that cancels a pending timer whenever it changes.
pub(crate) struct AwayLock {
    generation: AtomicU64,
    any_focused: AtomicBool,
    dialogs_open: AtomicU32,
}

impl AwayLock {
    const fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            any_focused: AtomicBool::new(true),
            dialogs_open: AtomicU32::new(0),
        }
    }

    fn cancel(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn away_now(&self) -> bool {
        !self.any_focused.load(Ordering::SeqCst) && self.dialogs_open.load(Ordering::SeqCst) == 0
    }

    /// Any focus change cancels the pending timer; losing focus with no
    /// Mindwtr dialog open returns the generation of a new one to start.
    fn focus_changed(&self, any_focused: bool) -> Option<u64> {
        self.any_focused.store(any_focused, Ordering::SeqCst);
        let generation = self.cancel();
        self.away_now().then_some(generation)
    }

    fn dialog_opened(&self) {
        self.dialogs_open.fetch_add(1, Ordering::SeqCst);
        self.cancel();
    }

    /// The last dialog closing while no window has focus starts the timer.
    fn dialog_closed(&self) -> Option<u64> {
        let _ = self
            .dialogs_open
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |open| {
                Some(open.saturating_sub(1))
            });
        let generation = self.cancel();
        self.away_now().then_some(generation)
    }

    /// The user just answered a prompt this window owns: treat Mindwtr as
    /// focused until the next real focus loss, so a late "focus is back"
    /// event cannot relock right after an unlock.
    fn unlocked(&self) {
        self.any_focused.store(true, Ordering::SeqCst);
        self.cancel();
    }

    fn should_fire(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation && self.away_now()
    }
}

fn away_delay(relock_delay_minutes: u8) -> Duration {
    if relock_delay_minutes == 0 {
        AWAY_GRACE
    } else {
        Duration::from_secs(u64::from(relock_delay_minutes) * 60)
    }
}

/// Sleeps on the async runtime (no thread, no blocked command) and calls
/// `fire` only if nothing changed the away state meanwhile.
fn spawn_away_timer(
    lock: &'static AwayLock,
    generation: u64,
    delay: Duration,
    fire: impl FnOnce() + Send + 'static,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if lock.should_fire(generation) {
            fire();
        }
    });
}

/// Rust runs the away timer, so a hidden window whose page timers the OS
/// slowed still locks on time, and the tray, Quick Add and notifications see
/// the lock at once.
fn arm_away_timer(app: &tauri::AppHandle, generation: Option<u64>) {
    let Some(generation) = generation else {
        return;
    };
    if !is_enabled() || is_locked() {
        return;
    }
    let app = app.clone();
    let delay = away_delay(RELOCK_DELAY.load(Ordering::SeqCst));
    spawn_away_timer(&AWAY, generation, delay, move || {
        if is_enabled() && !is_locked() {
            engage_and_notify(&app, "away");
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
// Linux only ever answers Unavailable.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub(crate) enum AppLockOutcome {
    Success,
    Cancelled,
    Failed,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppLockState {
    enabled: bool,
    relock_delay_minutes: u8,
    locked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppLockAvailability {
    /// False on Linux: the setting is hidden, not just disabled.
    supported: bool,
    /// False when the OS check is not set up (no Windows Hello, no Mac password).
    available: bool,
}

const SUPPORTED: bool = cfg!(any(target_os = "windows", target_os = "macos"));

fn normalize_relock_delay(value: Option<u8>) -> u8 {
    value
        .filter(|minutes| RELOCK_DELAY_OPTIONS.contains(minutes))
        .unwrap_or(0)
}

fn app_lock_config_from(config: &AppConfigToml) -> (bool, u8) {
    (
        SUPPORTED && config.app_lock_enabled == Some(true),
        normalize_relock_delay(config.app_lock_relock_delay_minutes),
    )
}

/// The one reader of the lock settings. A workspaces change points this (and
/// the writer below) at the device-level root; nothing else reads the keys.
fn read_app_lock_config(app: &tauri::AppHandle) -> (bool, u8) {
    app_lock_config_from(&read_config(app))
}

/// The one writer of the lock settings. `None` leaves a field as stored.
fn write_app_lock_config(
    app: &tauri::AppHandle,
    enabled: Option<bool>,
    relock_delay_minutes: Option<u8>,
) -> Result<(bool, u8), String> {
    let _config_guard = lock_config_read_modify_write()?;
    let mut config = crate::config::read_config_verified(app)?;
    if let Some(enabled) = enabled {
        config.app_lock_enabled = Some(enabled);
    }
    if let Some(minutes) = relock_delay_minutes {
        config.app_lock_relock_delay_minutes = Some(normalize_relock_delay(Some(minutes)));
    }
    write_config_files(&get_config_path(app), &get_secrets_path(app), &config)?;
    let (enabled, delay) = app_lock_config_from(&config);
    ENABLED.store(enabled, Ordering::SeqCst);
    RELOCK_DELAY.store(delay, Ordering::SeqCst);
    Ok((enabled, delay))
}

/// Runs once per process, from setup and again (as a no-op) from the
/// renderer's first ask, whichever comes first: a launch with the lock on
/// starts locked. A webview reload keeps the process's lock state.
pub(crate) fn init(app: &tauri::AppHandle) {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let (enabled, delay) = read_app_lock_config(app);
        ENABLED.store(enabled, Ordering::SeqCst);
        RELOCK_DELAY.store(delay, Ordering::SeqCst);
        LOCKED.store(enabled, Ordering::SeqCst);
    });
}

pub(crate) fn is_locked() -> bool {
    LOCKED.load(Ordering::SeqCst)
}

pub(crate) fn is_enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

fn current_state() -> AppLockState {
    AppLockState {
        enabled: is_enabled(),
        relock_delay_minutes: RELOCK_DELAY.load(Ordering::SeqCst),
        locked: is_locked(),
    }
}

/// Locks and clears every native surface that can show task text: the
/// Quick Add window (its autocomplete lists projects) and the tray tooltip
/// (today's Focus titles). The renderer re-sends the tooltip after unlock.
fn engage(app: &tauri::AppHandle) -> bool {
    if !is_enabled() {
        return false;
    }
    LOCKED.store(true, Ordering::SeqCst);
    let quick_add_open = app
        .get_webview_window(QUICK_ADD_WINDOW_LABEL)
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    if quick_add_open {
        let _ = crate::ui::hide_quick_add_window_for_app(app);
    }
    #[cfg(not(target_os = "linux"))]
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(NEUTRAL_TRAY_TOOLTIP));
    }
    true
}

fn log_lock_line(app: &tauri::AppHandle, message: String) {
    log::info!("{message}");
    crate::logging::append_native_log_line(app, &message);
}

/// A lock Rust started (tray item or away timer): engage, log it here (the
/// renderer may be asleep in a hidden window), and tell the main window.
fn engage_and_notify(app: &tauri::AppHandle, trigger: &'static str) {
    if engage(app) {
        let message = format!(
            "App lock engaged extra.releaseCheck=v1.3.8/desktop-app-lock trigger={trigger}"
        );
        log_lock_line(app, message);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("app-lock-engaged", trigger);
        }
    }
}

/// The tray's "Lock Mindwtr" item.
pub(crate) fn engage_from_tray(app: &tauri::AppHandle) {
    engage_and_notify(app, "manual");
}

/// Any window's focus change. "Away" means no Mindwtr window (main or Quick
/// Add) has focus, so moving between Mindwtr's own windows is not leaving.
pub(crate) fn focus_changed(app: &tauri::AppHandle) {
    let any_focused = app
        .webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false));
    arm_away_timer(app, AWAY.focus_changed(any_focused));
}

/// Holds the shared "Mindwtr dialog open" count for its lifetime, so a file
/// dialog or OS prompt taking focus is not counted as leaving.
struct DialogOpen(tauri::AppHandle);

impl DialogOpen {
    fn begin(app: &tauri::AppHandle) -> Self {
        AWAY.dialog_opened();
        Self(app.clone())
    }
}

impl Drop for DialogOpen {
    fn drop(&mut self) {
        arm_away_timer(&self.0, AWAY.dialog_closed());
    }
}

#[tauri::command]
pub(crate) async fn app_lock_dialog_begin() {
    AWAY.dialog_opened();
}

#[tauri::command]
pub(crate) async fn app_lock_dialog_end(app: tauri::AppHandle) {
    arm_away_timer(&app, AWAY.dialog_closed());
}

/// The tooltip to show: a neutral one while locked, whatever was asked otherwise.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub(crate) fn tray_tooltip(requested: Option<String>) -> Option<String> {
    if is_locked() {
        Some(NEUTRAL_TRAY_TOOLTIP.to_string())
    } else {
        requested
    }
}

#[tauri::command]
pub(crate) async fn get_app_lock_state(app: tauri::AppHandle) -> AppLockState {
    init(&app);
    current_state()
}

#[tauri::command]
pub(crate) async fn app_lock_engage(app: tauri::AppHandle) -> AppLockState {
    engage(&app);
    current_state()
}

#[tauri::command]
pub(crate) async fn app_lock_availability() -> AppLockAvailability {
    let available = tauri::async_runtime::spawn_blocking(platform::availability)
        .await
        .unwrap_or(false);
    AppLockAvailability {
        supported: SUPPORTED,
        available,
    }
}

async fn run_check(app: &tauri::AppHandle, reason: String) -> AppLockOutcome {
    let hwnd = main_window_handle(app);
    let _prompt_open = DialogOpen::begin(app);
    tauri::async_runtime::spawn_blocking(move || platform::authenticate(hwnd, &reason))
        .await
        .unwrap_or(AppLockOutcome::Failed)
}

/// Runs the OS check; a success unlocks. `reason` is the localized line the
/// OS prompt shows.
#[tauri::command]
pub(crate) async fn app_lock_authenticate(app: tauri::AppHandle, reason: String) -> AppLockOutcome {
    let outcome = run_check(&app, reason).await;
    if outcome == AppLockOutcome::Success {
        LOCKED.store(false, Ordering::SeqCst);
        AWAY.unlocked();
    }
    outcome
}

/// The lock screen's way out when the OS check cannot run (Remote Desktop,
/// a policy, a reset Windows Hello): turning the lock off is allowed only
/// when the lock is not really on, or when the OS itself says no check is
/// available right now. Anyone in this OS session can read the data file
/// anyway; refusing here would only lock the owner out.
fn may_turn_off_from_lock_screen(enabled: bool, available: bool) -> bool {
    !enabled || !available
}

/// Re-checks availability itself (the renderer's word is not enough) and, only
/// when the OS reports no check is possible, turns the lock off and unlocks.
#[tauri::command]
pub(crate) async fn app_lock_disable_unavailable(
    app: tauri::AppHandle,
) -> Result<AppLockOutcome, String> {
    let available = tauri::async_runtime::spawn_blocking(platform::availability)
        .await
        .unwrap_or(false);
    if !may_turn_off_from_lock_screen(is_enabled(), available) {
        log_lock_line(
            &app,
            "App lock turn-off refused extra.releaseCheck=v1.3.8/desktop-app-lock outcome=refused-available".to_string(),
        );
        return Ok(AppLockOutcome::Failed);
    }
    if is_enabled() {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            write_app_lock_config(&handle, Some(false), None)
        })
        .await
        .map_err(|error| error.to_string())??;
    }
    LOCKED.store(false, Ordering::SeqCst);
    AWAY.unlocked();
    log_lock_line(
        &app,
        "App lock turned off extra.releaseCheck=v1.3.8/desktop-app-lock outcome=disabled-unavailable".to_string(),
    );
    Ok(AppLockOutcome::Success)
}

/// Turning the lock on needs one successful OS check first, done here so no
/// caller can skip it. Turning it off is refused while locked (Settings is
/// behind the lock, so only a stray call could ask).
#[tauri::command]
pub(crate) async fn set_app_lock_enabled(
    app: tauri::AppHandle,
    enabled: bool,
    reason: String,
) -> Result<AppLockOutcome, String> {
    if enabled && !is_enabled() {
        let outcome = run_check(&app, reason).await;
        if outcome != AppLockOutcome::Success {
            return Ok(outcome);
        }
    }
    if !enabled && is_locked() {
        return Ok(AppLockOutcome::Failed);
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_app_lock_config(&handle, Some(enabled), None)
    })
    .await
    .map_err(|error| error.to_string())??;
    if !enabled {
        LOCKED.store(false, Ordering::SeqCst);
    }
    Ok(AppLockOutcome::Success)
}

#[tauri::command]
pub(crate) async fn set_app_lock_relock_delay(
    app: tauri::AppHandle,
    minutes: u8,
) -> Result<AppLockState, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_app_lock_config(&handle, None, Some(minutes))
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(current_state())
}

#[cfg(target_os = "windows")]
fn main_window_handle(app: &tauri::AppHandle) -> Option<isize> {
    app.get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
}

#[cfg(not(target_os = "windows"))]
fn main_window_handle(_app: &tauri::AppHandle) -> Option<isize> {
    None
}

#[cfg(target_os = "windows")]
mod platform {
    use super::AppLockOutcome;
    use windows::core::{factory, HSTRING};
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows_future::IAsyncOperation;

    pub(super) fn availability() -> bool {
        UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|operation| operation.get())
            .map(|value| value == UserConsentVerifierAvailability::Available)
            .unwrap_or(false)
    }

    /// The window-parented interop form: a desktop app's plain
    /// RequestVerificationAsync prompt opens behind the window.
    pub(super) fn authenticate(hwnd: Option<isize>, reason: &str) -> AppLockOutcome {
        let Some(hwnd) = hwnd else {
            return AppLockOutcome::Failed;
        };
        let result = (|| -> windows::core::Result<UserConsentVerificationResult> {
            let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
            let operation: IAsyncOperation<UserConsentVerificationResult> = unsafe {
                interop.RequestVerificationForWindowAsync(
                    HWND(hwnd as *mut core::ffi::c_void),
                    &HSTRING::from(reason),
                )
            }?;
            operation.get()
        })();
        match result {
            Ok(UserConsentVerificationResult::Verified) => AppLockOutcome::Success,
            Ok(UserConsentVerificationResult::Canceled) => AppLockOutcome::Cancelled,
            Ok(UserConsentVerificationResult::DeviceNotPresent)
            | Ok(UserConsentVerificationResult::NotConfiguredForUser)
            | Ok(UserConsentVerificationResult::DisabledByPolicy) => AppLockOutcome::Unavailable,
            Ok(_) => AppLockOutcome::Failed,
            Err(error) => {
                log::warn!("Windows Hello check failed: {error}");
                AppLockOutcome::Failed
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::AppLockOutcome;
    use std::ffi::CString;
    use std::os::raw::c_char;

    unsafe extern "C" {
        fn mindwtr_app_lock_available() -> bool;
        fn mindwtr_app_lock_authenticate(reason: *const c_char) -> i32;
    }

    pub(super) fn availability() -> bool {
        unsafe { mindwtr_app_lock_available() }
    }

    /// LAPolicyDeviceOwnerAuthentication: Touch ID, falling back to the
    /// account password. Blocks this (spawn_blocking) thread until answered.
    pub(super) fn authenticate(_hwnd: Option<isize>, reason: &str) -> AppLockOutcome {
        let reason = CString::new(reason.replace('\0', "")).unwrap_or_default();
        match unsafe { mindwtr_app_lock_authenticate(reason.as_ptr()) } {
            0 => AppLockOutcome::Success,
            1 => AppLockOutcome::Cancelled,
            3 => AppLockOutcome::Unavailable,
            _ => AppLockOutcome::Failed,
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::AppLockOutcome;

    pub(super) fn availability() -> bool {
        false
    }

    pub(super) fn authenticate(_hwnd: Option<isize>, _reason: &str) -> AppLockOutcome {
        AppLockOutcome::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relock_delay_keeps_known_choices_and_reads_others_as_zero() {
        for minutes in RELOCK_DELAY_OPTIONS {
            assert_eq!(normalize_relock_delay(Some(minutes)), minutes);
        }
        assert_eq!(normalize_relock_delay(Some(7)), 0);
        assert_eq!(normalize_relock_delay(None), 0);
    }

    #[test]
    fn lock_config_reads_enabled_only_where_the_os_check_exists() {
        let config = AppConfigToml {
            app_lock_enabled: Some(true),
            app_lock_relock_delay_minutes: Some(5),
            ..AppConfigToml::default()
        };
        assert_eq!(app_lock_config_from(&config), (SUPPORTED, 5));
        assert_eq!(app_lock_config_from(&AppConfigToml::default()), (false, 0));
    }

    #[test]
    fn away_lock_fires_only_while_no_window_is_focused_and_no_dialog_is_open() {
        let lock = AwayLock::new();
        let lost = lock
            .focus_changed(false)
            .expect("focus lost starts a timer");
        assert!(lock.should_fire(lost));

        // Coming back cancels it.
        lock.focus_changed(false);
        let lost = lock.focus_changed(false).unwrap();
        lock.focus_changed(true);
        assert!(!lock.should_fire(lost));

        // A Mindwtr dialog opening cancels it, and losing focus while one is
        // open starts nothing; the last dialog closing while away starts it.
        let lost = lock.focus_changed(false).unwrap();
        lock.dialog_opened();
        assert!(!lock.should_fire(lost));
        assert_eq!(lock.focus_changed(false), None);
        let closed = lock.dialog_closed().expect("dialog closed while away");
        assert!(lock.should_fire(closed));

        // Closing a dialog while focused starts nothing.
        lock.focus_changed(true);
        lock.dialog_opened();
        assert_eq!(lock.dialog_closed(), None);
    }

    #[test]
    fn an_unlock_is_not_followed_by_an_away_relock_from_stale_focus() {
        let lock = AwayLock::new();
        lock.focus_changed(false);
        // The OS prompt is a dialog; it closes before "focus is back" arrives.
        lock.dialog_opened();
        let after_prompt = lock.dialog_closed().unwrap();
        lock.unlocked();
        assert!(!lock.should_fire(after_prompt));
        assert!(!lock.away_now());
    }

    #[test]
    fn away_delay_uses_the_grace_for_zero() {
        assert_eq!(away_delay(0), AWAY_GRACE);
        assert_eq!(away_delay(5), Duration::from_secs(300));
    }

    #[test]
    fn away_timer_fires_after_the_delay_unless_cancelled() {
        let lock: &'static AwayLock = Box::leak(Box::new(AwayLock::new()));
        let (sender, receiver) = std::sync::mpsc::channel();

        let generation = lock.focus_changed(false).unwrap();
        let first = sender.clone();
        spawn_away_timer(lock, generation, Duration::from_millis(20), move || {
            let _ = first.send("first");
        });
        assert_eq!(receiver.recv_timeout(Duration::from_secs(5)), Ok("first"));

        let generation = lock.focus_changed(false).unwrap();
        spawn_away_timer(lock, generation, Duration::from_millis(50), move || {
            let _ = sender.send("second");
        });
        lock.focus_changed(true);
        assert!(receiver.recv_timeout(Duration::from_millis(400)).is_err());
    }

    #[test]
    fn the_lock_screen_may_turn_the_lock_off_only_when_no_check_is_possible() {
        assert!(may_turn_off_from_lock_screen(true, false));
        assert!(!may_turn_off_from_lock_screen(true, true));
        assert!(may_turn_off_from_lock_screen(false, true));
    }

    #[test]
    fn locked_tray_tooltip_carries_no_task_text() {
        LOCKED.store(true, Ordering::SeqCst);
        assert_eq!(
            tray_tooltip(Some("Today's Focus: Call the bank".to_string())).as_deref(),
            Some(NEUTRAL_TRAY_TOOLTIP)
        );
        LOCKED.store(false, Ordering::SeqCst);
        assert_eq!(
            tray_tooltip(Some("Today's Focus: Call the bank".to_string())).as_deref(),
            Some("Today's Focus: Call the bank")
        );
    }
}
