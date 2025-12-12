import { Colors } from '../constants/theme';
import { useTheme } from '../contexts/theme-context';
import { useTaskStore } from '@mindwtr/core';

export interface ThemeColors {
    bg: string;
    cardBg: string;
    text: string;
    secondaryText: string;
    border: string;
    tint: string;
    inputBg: string;
    danger: string;
    success: string;
    warning: string;
    filterBg: string;
}

export function useThemeColors() {
    const { isDark } = useTheme();
    const { settings } = useTaskStore();
    const accentColor = settings?.accentColor;

    const tc: ThemeColors = {
        bg: isDark ? Colors.dark.background : Colors.light.background,
        cardBg: isDark ? '#1F2937' : '#FFFFFF', // Using the values found in existing code
        text: isDark ? Colors.dark.text : Colors.light.text,
        secondaryText: isDark ? '#9CA3AF' : '#6B7280',
        border: isDark ? '#374151' : '#E5E7EB',
        tint: accentColor || (isDark ? Colors.dark.tint : Colors.light.tint),
        inputBg: isDark ? '#374151' : '#F3F4F6',
        danger: '#EF4444',
        success: '#10B981',
        warning: '#F59E0B',
        filterBg: isDark ? '#374151' : '#F3F4F6'
    };

    return tc;
}
