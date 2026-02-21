import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme as useSystemColorScheme } from 'react-native';
import { useTaskStore } from '@mindwtr/core';
import { logError } from '../lib/app-log';
import { markStartupPhase, measureStartupPhase } from '../lib/startup-profiler';

type ThemeMode = 'system' | 'light' | 'dark' | 'material3-light' | 'material3-dark' | 'eink' | 'nord' | 'sepia' | 'oled';
type ThemePreset = 'default' | 'eink' | 'nord' | 'sepia' | 'oled';
type ThemeStyle = 'default' | 'material3';
type ColorScheme = 'light' | 'dark';

interface ThemeContextType {
    themeMode: ThemeMode;
    themeStyle: ThemeStyle;
    themePreset: ThemePreset;
    colorScheme: ColorScheme;
    setThemeMode: (mode: ThemeMode) => void;
    setThemeStyle: (style: ThemeStyle) => void;
    isDark: boolean;
    isReady: boolean;
}

const THEME_STORAGE_KEY = '@mindwtr_theme';
const THEME_STYLE_STORAGE_KEY = '@mindwtr_theme_style';

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const systemColorScheme = useSystemColorScheme() ?? 'light';
    const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
    const [themeStyle, setThemeStyleState] = useState<ThemeStyle>('default');
    const [isReady, setIsReady] = useState(false);
    const readSyncedTheme = (): ThemeMode | undefined => {
        const raw = (useTaskStore as unknown as { getState?: () => { settings?: { theme?: unknown } } })
            ?.getState?.()
            ?.settings
            ?.theme;
        if (typeof raw !== 'string') return undefined;
        return raw as ThemeMode;
    };
    const [syncedTheme, setSyncedTheme] = useState<ThemeMode | undefined>(() => readSyncedTheme());

    const themePreset: ThemePreset =
        themeMode === 'eink' ? 'eink' :
        themeMode === 'nord' ? 'nord' :
        themeMode === 'sepia' ? 'sepia' :
        themeMode === 'oled' ? 'oled' :
        'default';

    const resolvedMode: ColorScheme | 'system' =
        themeMode === 'material3-light'
            ? 'light'
            : themeMode === 'material3-dark'
                ? 'dark'
                : themeMode === 'nord' || themeMode === 'oled'
                    ? 'dark'
                    : themeMode === 'eink' || themeMode === 'sepia'
                        ? 'light'
                        : themeMode;

    // Determine actual color scheme based on mode and system
    const colorScheme: ColorScheme = resolvedMode === 'system' ? systemColorScheme : resolvedMode;
    const isDark = colorScheme === 'dark';

    useEffect(() => {
        loadThemePreference();
    }, []);

    useEffect(() => {
        const store = useTaskStore as unknown as {
            subscribe?: (listener: (state: { settings?: { theme?: unknown } }, prevState: { settings?: { theme?: unknown } }) => void) => (() => void) | void;
        };
        if (typeof store.subscribe !== 'function') {
            setSyncedTheme(readSyncedTheme());
            return;
        }
        const unsubscribe = store.subscribe((state, prevState) => {
            if (state?.settings?.theme === prevState?.settings?.theme) return;
            const next = state?.settings?.theme;
            setSyncedTheme(typeof next === 'string' ? (next as ThemeMode) : undefined);
        });
        setSyncedTheme(readSyncedTheme());
        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        };
    }, []);

    useEffect(() => {
        if (!syncedTheme) return;
        if (syncedTheme === themeMode) return;
        void setThemeMode(syncedTheme);
    }, [syncedTheme, themeMode]);

    const loadThemePreference = async () => {
        try {
            markStartupPhase('js.theme.load:start');
            const [savedThemeMode, savedThemeStyle] = await measureStartupPhase('js.theme.async_storage_read', async () =>
                Promise.all([
                    AsyncStorage.getItem(THEME_STORAGE_KEY),
                    AsyncStorage.getItem(THEME_STYLE_STORAGE_KEY),
                ])
            );
            if (savedThemeMode) {
                setThemeModeState(savedThemeMode as ThemeMode);
            }
            if (savedThemeMode === 'material3-light' || savedThemeMode === 'material3-dark') {
                setThemeStyleState('material3');
            } else if (savedThemeStyle) {
                setThemeStyleState(savedThemeStyle as ThemeStyle);
            }
        } catch (e) {
            void logError(e, { scope: 'theme', extra: { message: 'Failed to load theme preference' } });
        } finally {
            setIsReady(true);
            markStartupPhase('js.theme.load:end');
        }
    };

    const setThemeMode = async (mode: ThemeMode) => {
        try {
            await AsyncStorage.setItem(THEME_STORAGE_KEY, mode);
            setThemeModeState(mode);
            if (mode === 'material3-light' || mode === 'material3-dark') {
                await AsyncStorage.setItem(THEME_STYLE_STORAGE_KEY, 'material3');
                setThemeStyleState('material3');
            } else {
                await AsyncStorage.setItem(THEME_STYLE_STORAGE_KEY, 'default');
                setThemeStyleState('default');
            }
        } catch (e) {
            void logError(e, { scope: 'theme', extra: { message: 'Failed to save theme preference' } });
        }
    };

    const setThemeStyle = async (style: ThemeStyle) => {
        try {
            await AsyncStorage.setItem(THEME_STYLE_STORAGE_KEY, style);
            setThemeStyleState(style);
        } catch (e) {
            void logError(e, { scope: 'theme', extra: { message: 'Failed to save theme preference' } });
        }
    };

    return (
        <ThemeContext.Provider value={{ themeMode, themeStyle, themePreset, colorScheme, setThemeMode, setThemeStyle, isDark, isReady }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
}
