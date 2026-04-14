import { useCallback, useEffect, useState } from 'react';

import {
    flushPendingSave,
    normalizeDateFormatSetting,
    normalizeTimeFormatSetting,
    type AppData,
} from '@mindwtr/core';

import type { Language } from '../../../contexts/language-context';
import type { GlobalQuickAddShortcutSetting } from '../../../lib/global-quick-add-shortcut';
import { reportError } from '../../../lib/report-error';
import {
    THEME_STORAGE_KEY,
    applyThemeMode,
    coerceDesktopThemeMode,
    mapSyncedThemeToDesktop,
    resolveNativeTheme,
    type DesktopThemeMode,
} from '../../../lib/theme';
import { coerceDesktopTextSize } from '../../../lib/text-size';
import type { SettingsMainPageProps } from './SettingsMainPage';

type MainPageProps = Omit<SettingsMainPageProps, 'languages' | 't'>;

type UseSettingsMainPageOptions = {
    globalQuickAddShortcut: GlobalQuickAddShortcutSetting;
    isFlatpak: boolean;
    isLinux: boolean;
    isTauri: boolean;
    keybindingStyle: 'vim' | 'emacs';
    language: Language;
    openHelp: () => void;
    setGlobalQuickAddShortcut: (shortcut: GlobalQuickAddShortcutSetting) => void;
    setKeybindingStyle: (style: 'vim' | 'emacs') => void;
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
    const [themeMode, setThemeMode] = useState<DesktopThemeMode>('system');

    const densityMode = (
        settings?.appearance?.density === 'compact' ? 'compact' : 'comfortable'
    ) as MainPageProps['densityMode'];
    const textSizeMode = coerceDesktopTextSize(settings?.appearance?.textSize);
    const dateFormat = normalizeDateFormatSetting(settings?.dateFormat);
    const timeFormat = normalizeTimeFormatSetting(settings?.timeFormat);
    const undoNotificationsEnabled = settings?.undoNotificationsEnabled !== false;
    const weekStart = settings?.weekStart === 'monday' ? 'monday' : 'sunday';
    const windowDecorationsEnabled = settings?.window?.decorations !== false;
    const closeBehavior = settings?.window?.closeBehavior ?? 'ask';
    const trayVisible = settings?.window?.showTray !== false;

    useEffect(() => {
        const savedTheme = coerceDesktopThemeMode(
            localStorage.getItem(THEME_STORAGE_KEY),
        );
        if (savedTheme) {
            setThemeMode(savedTheme);
        }
    }, []);

    useEffect(() => {
        const syncedTheme = mapSyncedThemeToDesktop(settings?.theme);
        if (!syncedTheme || syncedTheme === themeMode) return;
        localStorage.setItem(THEME_STORAGE_KEY, syncedTheme);
        setThemeMode(syncedTheme);
    }, [settings?.theme, themeMode]);

    useEffect(() => {
        applyThemeMode(themeMode);

        if (!isTauri) return;
        const tauriTheme = resolveNativeTheme(themeMode);
        import('@tauri-apps/api/app')
            .then(({ setTheme }) => setTheme(tauriTheme))
            .catch((error) => reportError('Failed to set theme', error));
    }, [isTauri, themeMode]);

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

    const onLanguageChange = useCallback((language: Language) => {
        setLanguage(language);
        updateSettings({ language })
            .then(showSaved)
            .catch((error) => reportError('Failed to update language', error));
    }, [setLanguage, showSaved, updateSettings]);

    const onWeekStartChange = useCallback((value: 'sunday' | 'monday') => {
        updateSettings({ weekStart: value })
            .then(showSaved)
            .catch((error) => reportError('Failed to update week start', error));
    }, [showSaved, updateSettings]);

    const onDateFormatChange = useCallback((value: MainPageProps['dateFormat']) => {
        updateSettings({ dateFormat: value })
            .then(showSaved)
            .catch((error) => reportError('Failed to update date format', error));
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

    const onKeybindingStyleChange = useCallback((style: 'vim' | 'emacs') => {
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
        dateFormat,
        densityMode,
        globalQuickAddShortcut,
        keybindingStyle,
        language,
        onCloseBehaviorChange,
        onDateFormatChange,
        onDensityChange,
        onGlobalQuickAddShortcutChange,
        onKeybindingStyleChange,
        onLanguageChange,
        onOpenHelp: openHelp,
        onTextSizeChange,
        onThemeChange,
        onTimeFormatChange,
        onTrayVisibleChange,
        onUndoNotificationsChange,
        onWeekStartChange,
        onWindowDecorationsChange,
        showCloseBehavior: isTauri && !isFlatpak,
        showTrayToggle: isTauri && !isFlatpak,
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
