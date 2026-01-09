import { Colors, Material3 } from '../constants/theme';
import { useTheme } from '../contexts/theme-context';

export interface ThemeColors {
    bg: string;
    cardBg: string;
    taskItemBg: string;
    text: string;
    secondaryText: string;
    border: string;
    tint: string;
    onTint: string;
    inputBg: string;
    danger: string;
    success: string;
    warning: string;
    filterBg: string;
}

export function useThemeColors() {
    const { isDark, themeStyle } = useTheme();
    const useMaterial3 = themeStyle === 'material3';

    if (useMaterial3) {
        const palette = isDark ? Material3.dark : Material3.light;
        return {
            bg: palette.background,
            cardBg: palette.surfaceContainer,
            taskItemBg: palette.surfaceContainerHigh,
            text: palette.text,
            secondaryText: palette.secondaryText,
            border: palette.outline,
            tint: palette.primary,
            onTint: palette.onPrimary,
            inputBg: palette.surfaceVariant,
            danger: palette.error,
            success: palette.success,
            warning: palette.warning,
            filterBg: palette.surfaceVariant,
        };
    }

    const tc: ThemeColors = {
        bg: isDark ? Colors.dark.background : Colors.light.background,
        cardBg: isDark ? '#1F2937' : '#FFFFFF', // Using the values found in existing code
        taskItemBg: isDark ? '#1F2937' : '#F8FAFC',
        text: isDark ? Colors.dark.text : Colors.light.text,
        secondaryText: isDark ? '#9CA3AF' : '#6B7280',
        border: isDark ? '#374151' : '#E5E7EB',
        tint: isDark ? Colors.dark.tint : Colors.light.tint,
        onTint: '#FFFFFF',
        inputBg: isDark ? '#374151' : '#F3F4F6',
        danger: '#EF4444',
        success: '#10B981',
        warning: '#F59E0B',
        filterBg: isDark ? '#374151' : '#F3F4F6'
    };

    return tc;
}
