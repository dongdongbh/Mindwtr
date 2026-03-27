import type { AppData } from '@mindwtr/core';

export type DesktopThemeMode = 'system' | 'light' | 'dark' | 'eink' | 'nord' | 'sepia';
export type SystemThemePreference = 'light' | 'dark' | null;
type NativeThemePreference = Exclude<SystemThemePreference, null>;
type NativeThemeWindow = {
    theme: () => Promise<SystemThemePreference>;
    onThemeChanged: (
        listener: (event: { payload: NativeThemePreference }) => void
    ) => Promise<() => void>;
};
type NativeThemeWindowModule = {
    getCurrentWindow: () => NativeThemeWindow;
};

export const THEME_STORAGE_KEY = 'mindwtr-theme';
const SYSTEM_THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';

const isDesktopThemeMode = (value: string | null | undefined): value is DesktopThemeMode => (
    value === 'system'
    || value === 'light'
    || value === 'dark'
    || value === 'eink'
    || value === 'nord'
    || value === 'sepia'
);

export const coerceDesktopThemeMode = (value: string | null | undefined): DesktopThemeMode | null => {
    if (!value) return null;
    if (isDesktopThemeMode(value)) return value;
    if (value === 'material3-dark' || value === 'oled') return 'dark';
    if (value === 'material3-light') return 'light';
    return null;
};

export const mapSyncedThemeToDesktop = (value: AppData['settings']['theme'] | null | undefined): DesktopThemeMode | null => {
    if (!value) return null;
    if (isDesktopThemeMode(value)) return value;
    if (value === 'material3-dark' || value === 'oled') return 'dark';
    if (value === 'material3-light') return 'light';
    return null;
};

export const resolveSystemThemePreference = (override?: SystemThemePreference): SystemThemePreference => {
    if (override === 'light' || override === 'dark') return override;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(SYSTEM_THEME_MEDIA_QUERY).matches ? 'dark' : 'light';
};

export const watchSystemThemePreference = (
    onChange: (theme: NativeThemePreference) => void
): (() => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => { };

    const mediaQuery = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY);
    const handler = (event: MediaQueryListEvent | { matches: boolean }) => {
        onChange(event.matches ? 'dark' : 'light');
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

export const applyThemeMode = (mode: DesktopThemeMode | null, systemTheme?: SystemThemePreference) => {
    const root = document.documentElement;
    root.classList.remove('theme-eink', 'theme-nord', 'theme-sepia');

    const prefersDark = resolveSystemThemePreference(systemTheme) === 'dark';
    if (mode === 'system' || mode === null) {
        root.classList.toggle('dark', prefersDark);
    } else if (mode === 'dark' || mode === 'nord') {
        root.classList.add('dark');
    } else {
        root.classList.remove('dark');
    }

    if (mode === 'eink') root.classList.add('theme-eink');
    if (mode === 'nord') root.classList.add('theme-nord');
    if (mode === 'sepia') root.classList.add('theme-sepia');
};

export const resolveNativeTheme = (mode: DesktopThemeMode | null): 'light' | 'dark' | null => {
    if (!mode || mode === 'system') return null;
    if (mode === 'dark' || mode === 'nord') return 'dark';
    return 'light';
};
