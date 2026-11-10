import { einkSafeColor } from '@mindwtr/core';
import { useContext } from 'react';
import { ThemeContext, type ThemeContextType } from '../contexts/theme-context';

type ResolvableTheme = Pick<ThemeContextType, 'themePreset'>;

export type EinkSafeColorFn = (color: string) => string;

export function resolveEinkSafeColor(theme?: ResolvableTheme | null): EinkSafeColorFn {
    const themePreset = theme?.themePreset;
    return (color: string) => einkSafeColor(color, themePreset);
}

export function useEinkSafeColor(): EinkSafeColorFn {
    return resolveEinkSafeColor(useContext(ThemeContext));
}

export function useThemePreset(): string | undefined {
    return useContext(ThemeContext)?.themePreset;
}
