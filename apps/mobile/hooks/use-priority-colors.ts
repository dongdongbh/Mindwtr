import { getTaskPriorityColors, type TaskPriority } from '@mindwtr/core';
import { useTheme, type ThemeContextType } from '../contexts/theme-context';

type ResolvableTheme = Pick<ThemeContextType, 'themePreset'>;

export type PriorityPalette = Readonly<Record<TaskPriority, string>>;

export function resolvePriorityColors(theme?: ResolvableTheme | null): PriorityPalette {
    return getTaskPriorityColors(theme?.themePreset);
}

export function usePriorityColors(): PriorityPalette {
    return resolvePriorityColors(useTheme());
}
