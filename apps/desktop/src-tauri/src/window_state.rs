//! Window geometry, remembered per monitor layout (#936).
//!
//! One saved rectangle cannot serve a docked 4K desktop and the same machine
//! over remote desktop: restoring the desktop's window onto the small screen
//! puts most of it off the edge, and clamping it there loses the desktop size
//! for good. So geometry is keyed by a signature of the screens that were
//! attached, and each layout keeps its own rectangle.
//!
//! Deliberately local and never synced — the screens on one machine say nothing
//! about the screens on another.

use crate::*;

const WINDOW_LAYOUTS_FILE_NAME: &str = "window-layouts.json";
const LEGACY_WINDOW_STATE_FILE_NAME: &str = "window-state.json";

/// Layouts kept before the least recently used ones are dropped. Someone who
/// changes remote-desktop resolution often would otherwise accumulate an entry
/// per resolution forever.
const MAX_REMEMBERED_LAYOUTS: usize = 8;

/// A window narrower or shorter than this is treated as unusable and ignored,
/// so a bad read can never save the user into a window they cannot grab.
const MIN_USABLE_SIZE: u32 = 320;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WindowGeometry {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    #[serde(default)]
    pub(crate) maximized: bool,
    #[serde(default)]
    pub(crate) fullscreen: bool,
}

/// A screen, in the terms the signature is built from. Logical size and a
/// position relative to the top-left of the whole desktop, so moving every
/// screen (a different primary, a docking station that renumbers outputs) does
/// not read as a different layout, while resolution or scale changes do.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ScreenInfo {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LayoutProfile {
    #[serde(flatten)]
    geometry: WindowGeometry,
    /// Unix milliseconds, used only to decide which layouts to forget.
    #[serde(default)]
    last_used_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WindowLayouts {
    #[serde(default)]
    profiles: HashMap<String, LayoutProfile>,
}

/// Names the set of attached screens. Monitor *names* are not part of it: they
/// are absent or duplicated on several platforms, and two identical external
/// panels would collide.
pub(crate) fn layout_signature(screens: &[ScreenInfo]) -> String {
    if screens.is_empty() {
        return "none".to_string();
    }
    let origin_x = screens.iter().map(|screen| screen.x).min().unwrap_or(0);
    let origin_y = screens.iter().map(|screen| screen.y).min().unwrap_or(0);
    let mut parts: Vec<String> = screens
        .iter()
        .map(|screen| {
            format!(
                "{}x{}@{:.2}+{},{}",
                screen.width,
                screen.height,
                screen.scale,
                screen.x - origin_x,
                screen.y - origin_y,
            )
        })
        .collect();
    // Enumeration order is not stable across sessions on every platform.
    parts.sort();
    parts.join("|")
}

/// Fits a rectangle inside `area`, shrinking before moving so a window carried
/// over from a larger layout stays fully reachable.
pub(crate) fn clamp_to_area(geometry: WindowGeometry, area: WindowGeometry) -> WindowGeometry {
    let width = geometry.width.min(area.width).max(1);
    let height = geometry.height.min(area.height).max(1);
    let max_x = area.x + area.width.saturating_sub(width) as i32;
    let max_y = area.y + area.height.saturating_sub(height) as i32;
    WindowGeometry {
        x: geometry.x.clamp(area.x, max_x.max(area.x)),
        y: geometry.y.clamp(area.y, max_y.max(area.y)),
        width,
        height,
        maximized: geometry.maximized,
        fullscreen: geometry.fullscreen,
    }
}

fn is_usable(geometry: &WindowGeometry) -> bool {
    geometry.width >= MIN_USABLE_SIZE && geometry.height >= MIN_USABLE_SIZE
}

/// What to apply on this launch.
///
/// A layout that has been seen before gets its own rectangle back, untouched. A
/// layout seen for the first time borrows the most recently used one, clamped to
/// the screen in front of the user — and because that is only ever read, the
/// layout it was borrowed from keeps its geometry for when the user returns to
/// it.
fn resolve_geometry(
    layouts: &WindowLayouts,
    signature: &str,
    area: Option<WindowGeometry>,
) -> Option<WindowGeometry> {
    if let Some(profile) = layouts.profiles.get(signature) {
        if is_usable(&profile.geometry) {
            return Some(profile.geometry);
        }
    }
    let most_recent = layouts
        .profiles
        .iter()
        .filter(|(key, profile)| key.as_str() != signature && is_usable(&profile.geometry))
        .max_by_key(|(_, profile)| profile.last_used_at)?
        .1
        .geometry;
    // Borrowed geometry has no claim on where the user left this screen's
    // window, so a maximized or fullscreen source starts plain here.
    let borrowed = WindowGeometry {
        maximized: false,
        fullscreen: false,
        ..most_recent
    };
    Some(match area {
        Some(area) => clamp_to_area(borrowed, area),
        None => borrowed,
    })
}

fn remember(
    layouts: &mut WindowLayouts,
    signature: &str,
    geometry: WindowGeometry,
    now_ms: i64,
    max_layouts: usize,
) {
    layouts.profiles.insert(
        signature.to_string(),
        LayoutProfile {
            geometry,
            last_used_at: now_ms,
        },
    );
    if layouts.profiles.len() <= max_layouts {
        return;
    }
    let mut keys: Vec<(String, i64)> = layouts
        .profiles
        .iter()
        .map(|(key, profile)| (key.clone(), profile.last_used_at))
        .collect();
    // Oldest first, and by key when two carry the same stamp so trimming is
    // deterministic rather than dependent on hash order.
    keys.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
    for (key, _) in keys.into_iter().take(layouts.profiles.len() - max_layouts) {
        layouts.profiles.remove(&key);
    }
}

fn seed_layout(
    layouts: &mut WindowLayouts,
    signature: &str,
    geometry: WindowGeometry,
    now_ms: i64,
) -> bool {
    if !is_usable(&geometry)
        || layouts
            .profiles
            .get(signature)
            .is_some_and(|profile| is_usable(&profile.geometry))
    {
        return false;
    }
    remember(layouts, signature, geometry, now_ms, MAX_REMEMBERED_LAYOUTS);
    true
}

/// v1.1.5 kept a single rectangle in the window-state plugin's file. Reading it
/// once means upgrading does not look like the reset this issue was about
/// (#936); it is only ever a starting point for the layout in front of the user,
/// and the file is left where it is.
#[derive(Debug, Clone, Copy, Deserialize)]
struct LegacyWindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
    #[serde(default)]
    fullscreen: bool,
}

fn parse_legacy_state(raw: &str) -> Option<WindowGeometry> {
    let states: HashMap<String, LegacyWindowState> = serde_json::from_str(raw).ok()?;
    let state = states.get("main")?;
    let geometry = WindowGeometry {
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
        maximized: state.maximized,
        fullscreen: state.fullscreen,
    };
    is_usable(&geometry).then_some(geometry)
}

fn legacy_geometry(candidates: &[PathBuf]) -> Option<WindowGeometry> {
    candidates
        .iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .find_map(|raw| parse_legacy_state(&raw))
}

fn layouts_path() -> PathBuf {
    crate::storage::get_device_config_dir_for_startup().join(WINDOW_LAYOUTS_FILE_NAME)
}

fn read_layouts() -> WindowLayouts {
    std::fs::read_to_string(layouts_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_layouts(layouts: &WindowLayouts) {
    let path = layouts_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(serialized) = serde_json::to_vec_pretty(layouts) {
        let _ = std::fs::write(path, serialized);
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn screens_of<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Vec<ScreenInfo> {
    window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let position = monitor.position().to_logical::<f64>(scale);
            ScreenInfo {
                x: position.x.round() as i32,
                y: position.y.round() as i32,
                width: size.width.round().max(0.0) as u32,
                height: size.height.round().max(0.0) as u32,
                scale,
            }
        })
        .collect()
}

/// The usable area of the screen the window is currently on, for clamping a
/// rectangle borrowed from another layout.
fn current_work_area<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<WindowGeometry> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let position = monitor.work_area().position;
    let size = monitor.work_area().size;
    Some(WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
        fullscreen: false,
    })
}

fn measured_normal_geometry<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<WindowGeometry> {
    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;
    Some(WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
        fullscreen: false,
    })
}

/// Applies the geometry saved for the screens attached right now. Called while
/// the window is still hidden, so nothing here is ever seen moving.
pub(crate) fn restore<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let mut layouts = read_layouts();
    let signature = layout_signature(&screens_of(window));
    let legacy_candidates = [
        // Portable installs redirected the plugin's file into their own profile.
        crate::storage::get_device_config_dir_for_startup().join(LEGACY_WINDOW_STATE_FILE_NAME),
        window
            .app_handle()
            .path()
            .app_config_dir()
            .unwrap_or_default()
            .join(LEGACY_WINDOW_STATE_FILE_NAME),
    ];
    let geometry = resolve_geometry(&layouts, &signature, current_work_area(window))
        .or_else(|| legacy_geometry(&legacy_candidates));
    // Seed before reveal so a first close while maximized or fullscreen can
    // update only those flags and retain this normal rectangle.
    if let Some(seed_geometry) = geometry.or_else(|| measured_normal_geometry(window)) {
        if seed_layout(&mut layouts, &signature, seed_geometry, now_ms()) {
            write_layouts(&layouts);
        }
    }
    let Some(geometry) = geometry else {
        return;
    };

    let _ = window.set_size(tauri::PhysicalSize {
        width: geometry.width,
        height: geometry.height,
    });
    // Only place the window where a screen actually is. Unplugging the monitor
    // it was on otherwise opens it somewhere unreachable; leaving the position
    // alone lets the OS put it somewhere sane.
    if any_screen_shows(window, geometry) {
        let _ = window.set_position(tauri::PhysicalPosition {
            x: geometry.x,
            y: geometry.y,
        });
    }
    if geometry.maximized {
        let _ = window.maximize();
    }
    if geometry.fullscreen {
        let _ = window.set_fullscreen(true);
    }
}

/// Whether two rectangles overlap at all — enough of the window has to land on
/// a screen for the user to grab it.
pub(crate) fn overlaps(window: WindowGeometry, screen: WindowGeometry) -> bool {
    let right = window.x.saturating_add(window.width as i32);
    let bottom = window.y.saturating_add(window.height as i32);
    let screen_right = screen.x.saturating_add(screen.width as i32);
    let screen_bottom = screen.y.saturating_add(screen.height as i32);
    window.x < screen_right && right > screen.x && window.y < screen_bottom && bottom > screen.y
}

fn any_screen_shows<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    geometry: WindowGeometry,
) -> bool {
    window
        .available_monitors()
        .map(|monitors| {
            monitors.iter().any(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                overlaps(
                    geometry,
                    WindowGeometry {
                        x: position.x,
                        y: position.y,
                        width: size.width,
                        height: size.height,
                        maximized: false,
                        fullscreen: false,
                    },
                )
            })
        })
        .unwrap_or(false)
}

fn geometry_for_save(
    previous: Option<WindowGeometry>,
    measured: Option<WindowGeometry>,
    maximized: bool,
    fullscreen: bool,
) -> Option<WindowGeometry> {
    if maximized || fullscreen {
        previous.map(|previous| WindowGeometry {
            maximized,
            fullscreen,
            ..previous
        })
    } else {
        measured.filter(is_usable)
    }
}

/// Stores the window's current geometry against the current screens.
///
/// A maximized or fullscreen window reports the screen's rectangle, not the one
/// the user sized, so only the flag is updated and the stored rectangle is left
/// as it was — that is what should come back when they un-maximize. A minimized
/// window reports nothing useful and is skipped entirely.
pub(crate) fn save<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let signature = layout_signature(&screens_of(&window));
    let mut layouts = read_layouts();
    let previous = layouts.profiles.get(&signature).map(|p| p.geometry);
    let measured = if maximized || fullscreen {
        None
    } else {
        measured_normal_geometry(&window)
    };
    let Some(geometry) = geometry_for_save(previous, measured, maximized, fullscreen) else {
        return;
    };

    remember(
        &mut layouts,
        &signature,
        geometry,
        now_ms(),
        MAX_REMEMBERED_LAYOUTS,
    );
    write_layouts(&layouts);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: i32, y: i32, width: u32, height: u32, scale: f64) -> ScreenInfo {
        ScreenInfo {
            x,
            y,
            width,
            height,
            scale,
        }
    }

    fn geometry(x: i32, y: i32, width: u32, height: u32) -> WindowGeometry {
        WindowGeometry {
            x,
            y,
            width,
            height,
            maximized: false,
            fullscreen: false,
        }
    }

    fn profile(geometry: WindowGeometry, last_used_at: i64) -> LayoutProfile {
        LayoutProfile {
            geometry,
            last_used_at,
        }
    }

    fn layouts(entries: &[(&str, WindowGeometry, i64)]) -> WindowLayouts {
        WindowLayouts {
            profiles: entries
                .iter()
                .map(|(key, geometry, stamp)| (key.to_string(), profile(*geometry, *stamp)))
                .collect(),
        }
    }

    #[test]
    fn signature_ignores_monitor_enumeration_order() {
        let left = screen(0, 0, 1920, 1080, 1.0);
        let right = screen(1920, 0, 2560, 1440, 1.25);
        assert_eq!(
            layout_signature(&[left, right]),
            layout_signature(&[right, left])
        );
    }

    #[test]
    fn signature_ignores_where_the_desktop_starts() {
        // Same two screens, same relative placement, different origin.
        assert_eq!(
            layout_signature(&[
                screen(0, 0, 1920, 1080, 1.0),
                screen(1920, 0, 1280, 720, 1.0)
            ]),
            layout_signature(&[
                screen(-1920, -300, 1920, 1080, 1.0),
                screen(0, -300, 1280, 720, 1.0)
            ])
        );
    }

    #[test]
    fn signature_separates_resolution_scale_and_arrangement() {
        let base = layout_signature(&[screen(0, 0, 1920, 1080, 1.0)]);
        assert_ne!(base, layout_signature(&[screen(0, 0, 1280, 720, 1.0)]));
        assert_ne!(base, layout_signature(&[screen(0, 0, 1920, 1080, 2.0)]));
        assert_ne!(
            layout_signature(&[
                screen(0, 0, 1920, 1080, 1.0),
                screen(1920, 0, 1920, 1080, 1.0)
            ]),
            layout_signature(&[
                screen(0, 0, 1920, 1080, 1.0),
                screen(0, 1080, 1920, 1080, 1.0)
            ]),
        );
    }

    #[test]
    fn known_layout_is_restored_verbatim() {
        let stored = geometry(120, 80, 1600, 900);
        let layouts = layouts(&[("desk", stored, 10)]);
        assert_eq!(
            resolve_geometry(&layouts, "desk", Some(geometry(0, 0, 1280, 720))),
            Some(stored),
            "a layout with its own profile must not be clamped to the current screen",
        );
    }

    #[test]
    fn new_layout_borrows_the_most_recent_geometry_clamped() {
        let layouts = layouts(&[
            ("old", geometry(0, 0, 1400, 900), 10),
            ("desk", geometry(200, 100, 2400, 1300), 50),
        ]);
        let restored = resolve_geometry(&layouts, "laptop", Some(geometry(0, 0, 1280, 720)));
        assert_eq!(restored, Some(geometry(0, 0, 1280, 720)));
    }

    #[test]
    fn borrowing_a_layout_never_changes_it() {
        let desk = geometry(200, 100, 2400, 1300);
        let mut stored = layouts(&[("desk", desk, 50)]);
        let _ = resolve_geometry(&stored, "laptop", Some(geometry(0, 0, 1280, 720)));
        remember(
            &mut stored,
            "laptop",
            geometry(0, 0, 1280, 720),
            60,
            MAX_REMEMBERED_LAYOUTS,
        );
        assert_eq!(
            stored.profiles.get("desk").map(|p| p.geometry),
            Some(desk),
            "the desktop must still be waiting with its own size",
        );
    }

    #[test]
    fn a_borrowed_window_does_not_arrive_maximized() {
        let source = WindowGeometry {
            maximized: true,
            fullscreen: true,
            ..geometry(0, 0, 1400, 900)
        };
        let restored =
            resolve_geometry(&layouts(&[("desk", source, 10)]), "laptop", None).expect("geometry");
        assert!(!restored.maximized && !restored.fullscreen);
    }

    #[test]
    fn first_ever_launch_has_nothing_to_restore() {
        assert_eq!(
            resolve_geometry(&WindowLayouts::default(), "desk", None),
            None
        );
    }

    #[test]
    fn first_maximized_or_fullscreen_close_keeps_the_seeded_normal_rectangle() {
        let normal = geometry(120, 80, 1200, 800);
        let mut stored = WindowLayouts::default();
        assert!(seed_layout(&mut stored, "desk", normal, 10));
        let previous = stored.profiles.get("desk").map(|profile| profile.geometry);

        for (maximized, fullscreen) in [(true, false), (false, true)] {
            assert_eq!(
                geometry_for_save(previous, None, maximized, fullscreen),
                Some(WindowGeometry {
                    maximized,
                    fullscreen,
                    ..normal
                })
            );
        }
    }

    #[test]
    fn seeding_does_not_overwrite_known_geometry() {
        let known = geometry(200, 100, 1600, 900);
        let mut stored = layouts(&[("desk", known, 50)]);

        assert!(!seed_layout(
            &mut stored,
            "desk",
            geometry(0, 0, 1200, 800),
            60
        ));
        assert_eq!(
            stored.profiles.get("desk").map(|profile| profile.geometry),
            Some(known)
        );
    }

    #[test]
    fn clamping_shrinks_before_it_moves() {
        let area = geometry(100, 50, 1280, 720);
        assert_eq!(
            clamp_to_area(geometry(2000, 1500, 2400, 1300), area),
            geometry(100, 50, 1280, 720),
        );
        assert_eq!(
            clamp_to_area(geometry(-500, -500, 800, 600), area),
            geometry(100, 50, 800, 600),
        );
        assert_eq!(
            clamp_to_area(geometry(200, 100, 800, 600), area),
            geometry(200, 100, 800, 600),
            "a rectangle that already fits is left alone",
        );
    }

    #[test]
    fn only_the_least_recently_used_layouts_are_forgotten() {
        let mut stored = WindowLayouts::default();
        for index in 0..MAX_REMEMBERED_LAYOUTS as i64 {
            remember(
                &mut stored,
                &format!("layout-{index}"),
                geometry(0, 0, 1200, 800),
                index,
                MAX_REMEMBERED_LAYOUTS,
            );
        }
        remember(
            &mut stored,
            "newest",
            geometry(0, 0, 1200, 800),
            999,
            MAX_REMEMBERED_LAYOUTS,
        );

        assert_eq!(stored.profiles.len(), MAX_REMEMBERED_LAYOUTS);
        assert!(stored.profiles.contains_key("newest"));
        assert!(!stored.profiles.contains_key("layout-0"));
        assert!(stored.profiles.contains_key("layout-1"));
    }

    #[test]
    fn revisiting_a_layout_keeps_it_from_being_trimmed() {
        let mut stored = WindowLayouts::default();
        for index in 0..MAX_REMEMBERED_LAYOUTS as i64 {
            remember(
                &mut stored,
                &format!("layout-{index}"),
                geometry(0, 0, 1200, 800),
                index,
                MAX_REMEMBERED_LAYOUTS,
            );
        }
        remember(
            &mut stored,
            "layout-0",
            geometry(0, 0, 1200, 800),
            500,
            MAX_REMEMBERED_LAYOUTS,
        );
        remember(
            &mut stored,
            "newest",
            geometry(0, 0, 1200, 800),
            999,
            MAX_REMEMBERED_LAYOUTS,
        );

        assert!(stored.profiles.contains_key("layout-0"));
        assert!(!stored.profiles.contains_key("layout-1"));
    }

    #[test]
    fn a_window_is_only_placed_where_a_screen_can_show_it() {
        let screen = geometry(0, 0, 1920, 1080);
        assert!(overlaps(geometry(100, 100, 800, 600), screen));
        assert!(
            overlaps(geometry(-200, 0, 800, 600), screen),
            "partly off the left edge is still reachable",
        );
        assert!(
            !overlaps(geometry(1920, 0, 800, 600), screen),
            "a window starting exactly past the right edge is on the other monitor",
        );
        assert!(!overlaps(geometry(0, -600, 800, 600), screen));
    }

    #[test]
    fn unusably_small_saved_geometry_is_ignored() {
        let layouts = layouts(&[("desk", geometry(0, 0, 40, 30), 10)]);
        assert_eq!(resolve_geometry(&layouts, "desk", None), None);
    }

    #[test]
    fn the_single_rectangle_from_1_1_5_is_read_once() {
        let raw = r#"{"main":{"width":1500,"height":950,"x":40,"y":60,"prev_x":0,"prev_y":0,
            "maximized":true,"visible":true,"decorated":true,"fullscreen":false}}"#;
        assert_eq!(
            parse_legacy_state(raw),
            Some(WindowGeometry {
                maximized: true,
                ..geometry(40, 60, 1500, 950)
            })
        );
    }

    #[test]
    fn a_legacy_file_that_no_longer_parses_is_simply_ignored() {
        assert_eq!(parse_legacy_state("not json"), None);
        assert_eq!(parse_legacy_state(r#"{"quick-add":{}}"#), None);
        assert_eq!(
            parse_legacy_state(r#"{"main":{"width":10,"height":10,"x":0,"y":0}}"#),
            None,
            "an unusable rectangle must not survive the migration either",
        );
    }

    #[test]
    fn profiles_survive_a_round_trip_through_the_file_format() {
        let stored = layouts(&[(
            "1920x1080@1.00+0,0",
            WindowGeometry {
                maximized: true,
                ..geometry(10, 20, 1400, 900)
            },
            42,
        )]);
        let json = serde_json::to_string(&stored).expect("serialize");
        let parsed: WindowLayouts = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            parsed.profiles["1920x1080@1.00+0,0"].geometry,
            stored.profiles["1920x1080@1.00+0,0"].geometry
        );
    }
}
