import { useCallback, useEffect, useState } from 'react';

import {
    flushPendingSave,
    canUseJalaliCalendar,
    normalizeDateFormatSetting,
    normalizeTimeFormatSetting,
    normalizeWeekStartPreference,
    resolveCalendarSystemSetting,
    type AppearanceSettings,
    type AppData,
    type NotificationSettings,
    type WindowSettings,
} from '@mindwtr/core';

import type { Language } from '../../../contexts/language-context';
import type { GlobalQuickAddShortcutSetting } from '../../../lib/global-quick-add-shortcut';
import {
    getLaunchAtStartupEnabled,
    setLaunchAtStartupEnabled as setSystemLaunchAtStartupEnabled,
} from '../../../lib/launch-at-startup';
import { reportError } from '../../../lib/report-error';
import { applyDesktopTheme } from '../../../lib/omarchy-theme';
import {
    THEME_STORAGE_KEY,
    applyNativeTheme,
    resolveDesktopThemeMode,
    resolveNativeTheme,
    resolveSystemThemeCommandPreference,
    type DesktopThemeMode,
} from '../../../lib/theme';
import { coerceDesktopTextSize } from '../../../lib/text-size';
import { coerceDesktopFontFamily } from '../../../lib/font-family';
import { resolveCloseBehavior } from '../../../lib/window-behavior';
import type { SettingsKeyboardWindowProps, SettingsMainPageProps } from './SettingsMainPage';

type MainPageProps = Omit<SettingsMainPageProps, 'languages' | 't' | 'translate'> & SettingsKeyboardWindowProps;

type UseSettingsMainPageOptions = {
    globalQuickAddShortcut: GlobalQuickAddShortcutSetting;
    isFlatpak: boolean;
    isLinux: boolean;
    isTauri: boolean;
    keybindingStyle: 'vim' | 'emacs' | 'standard';
    language: Language;
    openHelp: () => void;
    setGlobalQuickAddShortcut: (shortcut: GlobalQuickAddShortcutSetting) => void;
    setKeybindingStyle: (style: 'vim' | 'emacs' | 'standard') => void;
    setLanguage: (language: Language) => void | Promise<void>;
    settings: AppData['settings'];
    showSaved: () => void;
    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;
};

export function useSettingsMainPage({
    globalQuickAddShortcut,
    isFlatpak,
    isLinux,
    isTauri,
    keybindingStyle,
    language,
    openHelp,
    setGlobalQuickAddShortcut,
    setKeybindingStyle,
    setLanguage,
    settings,
    showSaved,
    updateSettings,
}: UseSettingsMainPageOptions): MainPageProps {
    const appearanceSettings: AppearanceSettings | undefined = settings?.appearance;
    const notificationSettings: NotificationSettings = settings ?? {};
    const windowSettings: WindowSettings | undefined = settings?.window;
    const [themeMode, setThemeMode] = useState<DesktopThemeMode>(() => (
        resolveDesktopThemeMode(settings?.theme, localStorage.getItem(THEME_STORAGE_KEY))
    ));
    const [launchAtStartupEnabled, setLaunchAtStartupEnabledState] = useState(
        windowSettings?.launchAtStartup === true,
    );
    const [launchAtStartupLoading, setLaunchAtStartupLoading] = useState(false);

    const densityMode = (
        appearanceSettings?.density === 'condensed'
            ? 'condensed'
            : appearanceSettings?.density === 'compact'
                ? 'compact'
                : 'comfortable'
    ) as MainPageProps['densityMode'];
    const textSizeMode = coerceDesktopTextSize(appearanceSettings?.textSize);
    const fontFamily = coerceDesktopFontFamily(appearanceSettings?.fontFamily);
    const showTaskAge = appearanceSettings?.showTaskAge === true;
    const dateFormat = normalizeDateFormatSetting(settings?.dateFormat);
    const timeFormat = normalizeTimeFormatSetting(settings?.timeFormat);
    const undoNotificationsEnabled = notificationSettings.undoNotificationsEnabled !== false;
    const weekStart = normalizeWeekStartPreference(settings?.weekStart);
    const systemLocale = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
        ? Intl.DateTimeFormat().resolvedOptions().locale
        : '';
    const showCalendarSystem = canUseJalaliCalendar({ language, systemLocale });
    const calendarSystem = resolveCalendarSystemSetting(settings?.calendarSystem, { language, systemLocale });
    const windowDecorationsEnabled = windowSettings?.decorations !== false;
    const closeBehavior = resolveCloseBehavior(windowSettings?.closeBehavior, isFlatpak);
    const trayVisible = windowSettings?.showTray !== false;

    useEffect(() => {
        const resolvedTheme = resolveDesktopThemeMode(settings?.theme, localStorage.getItem(THEME_STORAGE_KEY));
        if (resolvedTheme === themeMode) return;
        localStorage.setItem(THEME_STORAGE_KEY, resolvedTheme);
        setThemeMode(resolvedTheme);
    }, [settings?.theme, themeMode]);

    useEffect(() => {
        let cancelled = false;
        applyDesktopTheme(themeMode, undefined, (step, error) => reportError(`Failed to read the Omarchy theme (${step})`, error));
        if (isTauri && (themeMode === 'system' || themeMode === 'system-oled')) {
            void resolveSystemThemeCommandPreference(
                (_step, error) => reportError('Failed to resolve system theme', error),
            ).then((theme) => {
                if (!cancelled && theme) {
                    applyDesktopTheme(themeMode, theme, (step, error) => reportError(`Failed to read the Omarchy theme (${step})`, error));
                    if (isLinux) void applyNativeTheme(
                        resolveNativeTheme(themeMode, theme),
                        () => import('@tauri-apps/api/app'),
                        () => import('@tauri-apps/api/window'),
                        (_step, error) => reportError('Failed to set theme', error),
                    );
                }
            });
        }

        if (!isTauri) return;
        const tauriTheme = resolveNativeTheme(themeMode);
        void applyNativeTheme(
            tauriTheme,
            () => import('@tauri-apps/api/app'),
            () => import('@tauri-apps/api/window'),
            (_step, error) => reportError('Failed to set theme', error),
        );
        return () => {
            cancelled = true;
        };
    }, [isLinux, isTauri, themeMode]);

    useEffect(() => {
        if (!isTauri || isFlatpak) return;
        let cancelled = false;
        getLaunchAtStartupEnabled()
            .then((enabled) => {
                if (cancelled) return;
                setLaunchAtStartupEnabledState(enabled);
                if ((settings?.window?.launchAtStartup === true) === enabled) return;
                return updateSettings({
                    window: {
                        ...(settings?.window ?? {}),
                        launchAtStartup: enabled,
                    },
                });
            })
            .catch((error) => reportError('Failed to read launch at startup setting', error));
        return () => {
            cancelled = true;
        };
    }, [isFlatpak, isTauri, settings?.window, updateSettings]);

    useEffect(() => {
        if (!isTauri || !isFlatpak) return;
        setLaunchAtStartupEnabledState(settings?.window?.launchAtStartup === true);
    }, [isFlatpak, isTauri, settings?.window?.launchAtStartup]);

    const onThemeChange = useCallback((mode: DesktopThemeMode) => {
        localStorage.setItem(THEME_STORAGE_KEY, mode);
        setThemeMode(mode);
        updateSettings({ theme: mode })
            .then(showSaved)
            .catch((error) => reportError('Failed to update theme', error));
    }, [showSaved, updateSettings]);

    const onDensityChange = useCallback((mode: MainPageProps['densityMode']) => {
        updateSettings({
            appearance: {
                ...(settings?.appearance ?? {}),
                density: mode,
            },
        })
            .then(showSaved)
            .catch((error) => reportError('Failed to update density', error));
    }, [settings?.appearance, showSaved, updateSettings]);

    const onTextSizeChange = useCallback((mode: MainPageProps['textSizeMode']) => {
        updateSettings({
            appearance: {
                ...(settings?.appearance ?? {}),
                textSize: mode,
            },
        })
            .then(showSaved)
            .catch((error) => reportError('Failed to update text size', error));
    }, [settings?.appearance, showSaved, updateSettings]);

    const onFontFamilyChange = useCallback((value: string) => {
        const next = coerceDesktopFontFamily(value);
        updateSettings({
            appearance: {
                ...(settings?.appearance ?? {}),
                fontFamily: next || undefined,
            },
        })
            .then(showSaved)
            .catch((error) => reportError('Failed to update font', error));
    }, [settings?.appearance, showSaved, updateSettings]);

    const onShowTaskAgeChange = useCallback((enabled: boolean) => {
        updateSettings({
            appearance: {
                ...(settings?.appearance ?? {}),
                showTaskAge: enabled,
            },
        })
            .then(showSaved)
            .catch((error) => reportError('Failed to update task age display', error));
    }, [settings?.appearance, showSaved, updateSettings]);

    const onLanguageChange = useCallback((language: Language) => {
        setLanguage(language);
        updateSettings({ language })
            .then(showSaved)
            .catch((error) => reportError('Failed to update language', error));
    }, [setLanguage, showSaved, updateSettings]);

    const onWeekStartChange = useCallback((value: MainPageProps['weekStart']) => {
        updateSettings({ weekStart: value })
            .then(showSaved)
            .catch((error) => reportError('Failed to update week start', error));
    }, [showSaved, updateSettings]);

    const onDateFormatChange = useCallback((value: MainPageProps['dateFormat']) => {
        updateSettings({ dateFormat: value })
            .then(showSaved)
            .catch((error) => reportError('Failed to update date format', error));
    }, [showSaved, updateSettings]);

    const onCalendarSystemChange = useCallback((value: MainPageProps['calendarSystem']) => {
        updateSettings({ calendarSystem: value })
            .then(showSaved)
            .catch((error) => reportError('Failed to update calendar system', error));
    }, [showSaved, updateSettings]);

    const onTimeFormatChange = useCallback((value: MainPageProps['timeFormat']) => {
        updateSettings({ timeFormat: value })
            .then(showSaved)
            .catch((error) => reportError('Failed to update time format', error));
    }, [showSaved, updateSettings]);

    const onWindowDecorationsChange = useCallback((enabled: boolean) => {
        updateSettings({
            window: {
                ...(settings?.window ?? {}),
                decorations: enabled,
            },
        })
            .then(showSaved)
            .catch((error) =>
                reportError('Failed to update window decorations', error),
            );

        if (!isTauri || !isLinux) return;
        import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) =>
                getCurrentWindow().setDecorations(enabled),
            )
            .catch((error) =>
                reportError('Failed to set window decorations', error),
            );
    }, [isLinux, isTauri, settings?.window, showSaved, updateSettings]);

    const onCloseBehaviorChange = useCallback((behavior: 'ask' | 'tray' | 'quit') => {
        updateSettings({
            window: {
                ...(settings?.window ?? {}),
                closeBehavior: behavior,
            },
        })
            .then(() => flushPendingSave())
            .then(showSaved)
            .catch((error) =>
                reportError('Failed to update close behavior', error),
            );
    }, [settings?.window, showSaved, updateSettings]);

    const onTrayVisibleChange = useCallback((visible: boolean) => {
        updateSettings({
            window: {
                ...(settings?.window ?? {}),
                showTray: visible,
            },
        })
            .then(() => flushPendingSave())
            .then(showSaved)
            .catch((error) =>
                reportError('Failed to update tray visibility setting', error),
            );
    }, [settings?.window, showSaved, updateSettings]);

    const onLaunchAtStartupChange = useCallback((enabled: boolean) => {
        if (!isTauri) return;
        setLaunchAtStartupLoading(true);
        setSystemLaunchAtStartupEnabled(enabled)
            .then((actualEnabled) => {
                setLaunchAtStartupEnabledState(actualEnabled);
                return updateSettings({
                    window: {
                        ...(settings?.window ?? {}),
                        launchAtStartup: actualEnabled,
                    },
                });
            })
            .then(() => flushPendingSave())
            .then(showSaved)
            .catch((error) => {
                reportError('Failed to update launch at startup setting', error);
                void getLaunchAtStartupEnabled()
                    .then(setLaunchAtStartupEnabledState)
                    .catch(() => undefined);
            })
            .finally(() => setLaunchAtStartupLoading(false));
    }, [isTauri, settings?.window, showSaved, updateSettings]);

    const onKeybindingStyleChange = useCallback((style: 'vim' | 'emacs' | 'standard') => {
        setKeybindingStyle(style);
        showSaved();
    }, [setKeybindingStyle, showSaved]);

    const onGlobalQuickAddShortcutChange = useCallback((shortcut: GlobalQuickAddShortcutSetting) => {
        setGlobalQuickAddShortcut(shortcut);
        showSaved();
    }, [setGlobalQuickAddShortcut, showSaved]);

    const onUndoNotificationsChange = useCallback((enabled: boolean) => {
        updateSettings({ undoNotificationsEnabled: enabled })
            .then(showSaved)
            .catch((error) =>
                reportError('Failed to update undo notifications setting', error),
            );
    }, [showSaved, updateSettings]);

    return {
        closeBehavior,
        calendarSystem,
        dateFormat,
        densityMode,
        globalQuickAddShortcut,
        isFlatpak,
        keybindingStyle,
        language,
        launchAtStartupEnabled,
        launchAtStartupLoading,
        onCloseBehaviorChange,
        onCalendarSystemChange,
        onDateFormatChange,
        onDensityChange,
        onGlobalQuickAddShortcutChange,
        onKeybindingStyleChange,
        onLanguageChange,
        onLaunchAtStartupChange,
        onOpenHelp: openHelp,
        onShowTaskAgeChange,
        onTextSizeChange,
        fontFamily,
        onFontFamilyChange,
        onThemeChange,
        onTimeFormatChange,
        onTrayVisibleChange,
        onUndoNotificationsChange,
        onWeekStartChange,
        onWindowDecorationsChange,
        showCloseBehavior: isTauri,
        showCalendarSystem,
        showLaunchAtStartup: isTauri,
        showTaskAge,
        showTrayToggle: isTauri,
        showWindowDecorations: isLinux,
        textSizeMode,
        themeMode,
        timeFormat,
        trayVisible,
        undoNotificationsEnabled,
        weekStart,
        windowDecorationsEnabled,
    };
}
