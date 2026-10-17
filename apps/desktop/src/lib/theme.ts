import type { AppData } from '@mindwtr/core';
import { THEME_DESCRIPTORS, resolveThemeColorScheme, themeDescriptor } from '@mindwtr/core';

import { invokeNative } from './tauri-invoke';
import { isLinuxRuntime } from './runtime';

// The themes desktop ships CSS for, read off core's registry rather than
// hand-listed here: `desktop: false` themes (material3-*) collapse below.
type DesktopThemeName = {
    [K in keyof typeof THEME_DESCRIPTORS]: (typeof THEME_DESCRIPTORS)[K]['desktop'] extends true ? K : never;
}[keyof typeof THEME_DESCRIPTORS];
export type DesktopThemeMode = 'system' | DesktopThemeName;
export type SystemThemePreference = 'light' | 'dark' | null;
type NativeThemePreference = Exclude<SystemThemePreference, null>;
type NativeThemeSetter = (theme?: NativeThemePreference | null) => Promise<void>;
type NativeThemeAppModule = {
    setTheme: NativeThemeSetter;
};
type NativeThemeWindow = {
    theme: () => Promise<SystemThemePreference>;
    setTheme?: NativeThemeSetter;
    onThemeChanged: (
        listener: (event: { payload: NativeThemePreference }) => void
    ) => Promise<() => void>;
};
type NativeThemeWindowModule = {
    getCurrentWindow: () => NativeThemeWindow;
};

export const THEME_STORAGE_KEY = 'mindwtr-theme';
const SYSTEM_THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';
const SYSTEM_THEME_PORTAL_CHANGED_EVENT = 'system-theme-portal-changed';
let cachedSystemThemePreference: SystemThemePreference = null;

/** Set by the Omarchy palette layer; see `setSystemSchemeOverride`. */
let systemSchemeOverride: SystemThemePreference = null;

const isDesktopThemeMode = (value: string | null | undefined): value is DesktopThemeMode => (
    value === 'system' || themeDescriptor(value)?.desktop === true
);

// A theme core knows but desktop has no CSS for (material3-*) collapses into
// the plain light/dark mode it renders as; anything else is not a theme at all.
const collapseUnsupportedDesktopTheme = (value: string): DesktopThemeMode | null => (
    themeDescriptor(value)?.scheme ?? null
);

export const coerceDesktopThemeMode = (value: string | null | undefined): DesktopThemeMode | null => {
    if (!value) return null;
    if (isDesktopThemeMode(value)) return value;
    return collapseUnsupportedDesktopTheme(value);
};

export const mapSyncedThemeToDesktop = (value: AppData['settings']['theme'] | null | undefined): DesktopThemeMode | null => {
    if (!value) return null;
    if (isDesktopThemeMode(value)) return value;
    return collapseUnsupportedDesktopTheme(value);
};

export const resolveDesktopThemeMode = (
    syncedTheme: AppData['settings']['theme'] | null | undefined,
    storedTheme: string | null | undefined,
): DesktopThemeMode => (
    mapSyncedThemeToDesktop(syncedTheme)
    ?? coerceDesktopThemeMode(storedTheme)
    ?? 'system'
);

export const resolveSystemThemePreference = (override?: SystemThemePreference): SystemThemePreference => {
    if (override === 'light' || override === 'dark') {
        cachedSystemThemePreference = override;
    }
    // The Omarchy palette outranks the platform signal while it is active, but
    // the platform signal still refreshes the cache for the moment it stops
    // being the source. Without the override, a portal or media event arriving
    // after the palette applied would flip the dark class against colors that
    // did not change.
    if (systemSchemeOverride) return systemSchemeOverride;
    if (override === 'light' || override === 'dark') return override;
    if (cachedSystemThemePreference) return cachedSystemThemePreference;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(SYSTEM_THEME_MEDIA_QUERY).matches ? 'dark' : 'light';
};

/**
 * Hands the light/dark decision to a theme source that knows better than the
 * platform, which today means the live Omarchy palette. `null` returns the
 * decision to the platform.
 */
export const setSystemSchemeOverride = (scheme: SystemThemePreference): void => {
    systemSchemeOverride = scheme;
};

export const coerceSystemThemePreference = (value: unknown): SystemThemePreference => {
    if (value === 'light' || value === 'dark') return value;
    return null;
};

export const resolveSystemThemeCommandPreference = async (
    onError?: (step: 'resolveSystem', error: unknown) => void,
): Promise<SystemThemePreference> => {
    try {
        return coerceSystemThemePreference(await invokeNative('get_system_theme_preference'));
    } catch (error) {
        onError?.('resolveSystem', error);
        return null;
    }
};

export const watchSystemThemePreference = (
    onChange: (theme: NativeThemePreference) => void
): (() => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => { };

    const mediaQuery = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY);
    let lastNotifiedTheme: NativeThemePreference | null = null;
    const handler = (event: MediaQueryListEvent | { matches: boolean }) => {
        const theme = event.matches ? 'dark' : 'light';
        if (theme === lastNotifiedTheme) return;
        lastNotifiedTheme = theme;
        onChange(theme);
    };

    if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handler as EventListener);
        return () => mediaQuery.removeEventListener('change', handler as EventListener);
    }

    if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(handler as (event: MediaQueryListEvent) => void);
        return () => mediaQuery.removeListener(handler as (event: MediaQueryListEvent) => void);
    }

    return () => { };
};

export const watchNativeSystemThemePreference = (
    loadWindowModule: () => Promise<NativeThemeWindowModule>,
    onChange: (theme: NativeThemePreference) => void,
    onError?: (step: 'resolveSystem' | 'watch', error: unknown) => void,
): (() => void) => {
    // GTK theme events reflect our own setTheme calls on Linux, not the portal preference.
    if (isLinuxRuntime()) return () => { };
    let cancelled = false;
    let stopWatchingNativeTheme = () => { };

    void loadWindowModule()
        .then(async ({ getCurrentWindow }) => {
            if (cancelled) return;
            const currentWindow = getCurrentWindow();

            try {
                const nativeTheme = await currentWindow.theme();
                if (!cancelled && nativeTheme) {
                    onChange(nativeTheme);
                }
            } catch (error) {
                if (!cancelled) {
                    onError?.('resolveSystem', error);
                }
            }

            if (cancelled) return;

            try {
                const unlisten = await currentWindow.onThemeChanged(({ payload }) => {
                    onChange(payload);
                });
                if (cancelled) {
                    unlisten();
                    return;
                }
                stopWatchingNativeTheme = unlisten;
            } catch (error) {
                if (!cancelled) {
                    onError?.('watch', error);
                }
            }
        })
        .catch((error) => {
            if (!cancelled) {
                onError?.('watch', error);
            }
        });

    return () => {
        cancelled = true;
        stopWatchingNativeTheme();
    };
};

export const watchSystemThemePortalPreference = (
    loadEventModule: () => Promise<{
        listen: (event: string, listener: (event: { payload: unknown }) => void) => Promise<() => void>;
    }>,
    onChange: (theme: NativeThemePreference) => void,
    onError?: (step: 'watch', error: unknown) => void,
): (() => void) => {
    let cancelled = false;
    let unlisten = () => { };
    void loadEventModule()
        .then(({ listen }) => listen(SYSTEM_THEME_PORTAL_CHANGED_EVENT, ({ payload }) => {
            const theme = coerceSystemThemePreference(payload);
            if (!cancelled && theme) onChange(theme);
        }))
        .then((stop) => {
            if (cancelled) stop();
            else unlisten = stop;
        })
        .catch((error) => {
            if (!cancelled) onError?.('watch', error);
        });

    return () => {
        cancelled = true;
        unlisten();
    };
};

// One entry per theme with its own CSS variable block in index.css. This single
// map drives both the reset and the apply below, so a new theme can't end up in
// one list and not the other — and whether it renders dark comes from core's
// classification, not a second hand-maintained list here.
const THEME_MODE_CLASSES = {
    eink: 'theme-eink',
    nord: 'theme-nord',
    sepia: 'theme-sepia',
    oled: 'theme-oled',
    'catppuccin-macchiato': 'theme-catppuccin-macchiato',
    dracula: 'theme-dracula',
} as const satisfies Partial<Record<DesktopThemeMode, string>>;

export const applyThemeMode = (mode: DesktopThemeMode | null, systemTheme?: SystemThemePreference) => {
    const root = document.documentElement;
    root.classList.remove(...Object.values(THEME_MODE_CLASSES));

    const prefersDark = resolveSystemThemePreference(systemTheme) === 'dark';
    const isDark = mode === null ? prefersDark : resolveThemeColorScheme(mode, prefersDark ? 'dark' : 'light') === 'dark';
    root.classList.toggle('dark', isDark);

    const themeClass = mode === 'system-oled' && isDark
        ? THEME_MODE_CLASSES.oled
        : THEME_MODE_CLASSES[mode as keyof typeof THEME_MODE_CLASSES];
    if (themeClass) root.classList.add(themeClass);
};

export const applySystemThemeChange = (
    mode: DesktopThemeMode | null,
    theme: NativeThemePreference,
    applyNative: (theme: NativeThemePreference) => void,
): void => {
    applyThemeMode(mode, theme);
    if (isLinuxRuntime()) applyNative(theme);
};

export const applyStartupSystemThemeBeforeApp = async (
    result: Promise<SystemThemePreference>,
    appOwnsTheme: () => boolean,
    apply: (theme: NativeThemePreference) => void,
): Promise<void> => {
    const theme = await result;
    if (theme && !appOwnsTheme()) apply(theme);
};

export const resolveNativeTheme = (
    mode: DesktopThemeMode | null,
    systemTheme = resolveSystemThemePreference(),
): 'light' | 'dark' | null => {
    if (!mode || mode === 'system' || mode === 'system-oled') {
        // Resolved rather than passed through: the Omarchy palette has to reach
        // the GTK titlebar too, and callers that already have the platform
        // theme in hand would otherwise bypass the override.
        return isLinuxRuntime() ? resolveSystemThemePreference(systemTheme) : null;
    }
    return resolveThemeColorScheme(mode, 'light');
};

export const applyNativeTheme = async (
    theme: ReturnType<typeof resolveNativeTheme>,
    loadAppModule: () => Promise<NativeThemeAppModule>,
    loadWindowModule: () => Promise<NativeThemeWindowModule>,
    onError?: (step: 'app' | 'window', error: unknown) => void,
): Promise<boolean> => {
    const applied = await Promise.all([
        loadAppModule()
            .then(async ({ setTheme }) => { await setTheme(theme); return true; })
            .catch((error) => { onError?.('app', error); return false; }),
        loadWindowModule()
            .then(async ({ getCurrentWindow }) => {
                const currentWindow = getCurrentWindow();
                if (typeof currentWindow.setTheme !== 'function') return false;
                await currentWindow.setTheme(theme);
                return true;
            })
            .catch((error) => { onError?.('window', error); return false; }),
    ]);
    return applied.every(Boolean);
};
