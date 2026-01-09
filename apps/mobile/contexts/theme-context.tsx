import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme as useSystemColorScheme } from 'react-native';

type ThemeMode = 'system' | 'light' | 'dark';
type ThemeStyle = 'default' | 'material3';
type ColorScheme = 'light' | 'dark';

interface ThemeContextType {
    themeMode: ThemeMode;
    themeStyle: ThemeStyle;
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

    // Determine actual color scheme based on mode and system
    const colorScheme: ColorScheme = themeMode === 'system' ? systemColorScheme : themeMode;
    const isDark = colorScheme === 'dark';

    useEffect(() => {
        loadThemePreference();
    }, []);

    const loadThemePreference = async () => {
        try {
            const [savedThemeMode, savedThemeStyle] = await Promise.all([
                AsyncStorage.getItem(THEME_STORAGE_KEY),
                AsyncStorage.getItem(THEME_STYLE_STORAGE_KEY),
            ]);
            if (savedThemeMode) {
                setThemeModeState(savedThemeMode as ThemeMode);
            }
            if (savedThemeStyle) {
                setThemeStyleState(savedThemeStyle as ThemeStyle);
            }
        } catch (e) {
            console.error('Failed to load theme preference:', e);
        } finally {
            setIsReady(true);
        }
    };

    const setThemeMode = async (mode: ThemeMode) => {
        try {
            await AsyncStorage.setItem(THEME_STORAGE_KEY, mode);
            setThemeModeState(mode);
        } catch (e) {
            console.error('Failed to save theme preference:', e);
        }
    };

    const setThemeStyle = async (style: ThemeStyle) => {
        try {
            await AsyncStorage.setItem(THEME_STYLE_STORAGE_KEY, style);
            setThemeStyleState(style);
        } catch (e) {
            console.error('Failed to save theme preference:', e);
        }
    };

    return (
        <ThemeContext.Provider value={{ themeMode, themeStyle, colorScheme, setThemeMode, setThemeStyle, isDark, isReady }}>
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
