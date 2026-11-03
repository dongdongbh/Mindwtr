import { useContext } from 'react';
import { STATUS_COLORS_BY_THEME } from '@mindwtr/core';
import type { StatusPalette } from '@mindwtr/core';
import { ThemeContext, type ThemeContextType } from '../contexts/theme-context';

export type { StatusColorSet, StatusPalette } from '@mindwtr/core';

type ResolvableTheme = Pick<ThemeContextType, 'isDark' | 'themePreset'>;


export function resolveStatusColors(theme?: ResolvableTheme | null): StatusPalette {
    if (!theme || theme.themePreset === 'default') {
        return STATUS_COLORS_BY_THEME[theme?.isDark ? 'dark' : 'light'];
    }
    return STATUS_COLORS_BY_THEME[theme.themePreset];
}

export function useStatusColors(): StatusPalette {
    return resolveStatusColors(useContext(ThemeContext));
}
