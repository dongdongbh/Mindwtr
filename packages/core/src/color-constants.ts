import type { ThemeStatusPreset } from './theme-scheme';
import type { TaskPriority } from './types';
export const DEFAULT_PROJECT_COLOR = '#94a3b8';
export const DEFAULT_AREA_COLOR = DEFAULT_PROJECT_COLOR;
export const isValidProjectColorOverride = (value: unknown): value is string | null | undefined =>
    value == null || typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);


export const AREA_PRESET_COLORS = [
    '#3b82f6',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#8b5cf6',
    '#ec4899',
    '#f97316',
    '#14b8a6',
    '#06b6d4',
    '#6366f1',
    '#f43f5e',
    '#64748b',
] as const;


export const TASK_PRIORITY_COLORS: Readonly<Record<TaskPriority, string>> = {
    urgent: '#dc2626',
    high: '#f97316',
    medium: '#ca8a04',
    low: '#3b82f6',
};

const EINK_TASK_PRIORITY_COLORS: Readonly<Record<TaskPriority, string>> = {
    urgent: '#000000',
    high: '#000000',
    medium: '#000000',
    low: '#000000',
};

export const TASK_PRIORITY_COLORS_BY_THEME: Readonly<Record<ThemeStatusPreset | 'light' | 'dark', Readonly<Record<TaskPriority, string>>>> = {
    light: TASK_PRIORITY_COLORS,
    dark: TASK_PRIORITY_COLORS,
    eink: EINK_TASK_PRIORITY_COLORS,
    nord: TASK_PRIORITY_COLORS,
    sepia: TASK_PRIORITY_COLORS,
    oled: TASK_PRIORITY_COLORS,
    'catppuccin-macchiato': TASK_PRIORITY_COLORS,
    dracula: TASK_PRIORITY_COLORS,
    'gruvbox-light': TASK_PRIORITY_COLORS,
    'gruvbox-dark': TASK_PRIORITY_COLORS,
};

export function getTaskPriorityColors(themePreset?: string | null): Readonly<Record<TaskPriority, string>> {
    if (!themePreset || themePreset === 'default') return TASK_PRIORITY_COLORS;
    return TASK_PRIORITY_COLORS_BY_THEME[themePreset as ThemeStatusPreset | 'light' | 'dark'] ?? TASK_PRIORITY_COLORS;
}

const isEinkPreset = (themePreset?: string | null): boolean => themePreset === 'eink';

export const einkSafeColor = (color: string, themePreset?: string | null): string =>
    isEinkPreset(themePreset) ? '#000000' : color;
