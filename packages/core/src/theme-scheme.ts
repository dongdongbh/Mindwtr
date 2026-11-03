


import type { AppTheme, TaskStatus } from './types';

export type ThemeColorScheme = 'light' | 'dark';


export type ThemeStatusPreset = 'eink' | 'nord' | 'sepia' | 'oled' | 'catppuccin-macchiato' | 'dracula' | 'gruvbox-light' | 'gruvbox-dark';

export type StatusColorSet = { bg: string; text: string; border: string };
export type StatusPalette = Record<TaskStatus, StatusColorSet>;

export type ThemeDescriptor = {

    scheme: ThemeColorScheme | 'system';

    statusPreset: ThemeStatusPreset | null;

    desktop: boolean;
};


export const THEME_DESCRIPTORS = {
    'light': { scheme: 'light', statusPreset: null, desktop: true },
    'dark': { scheme: 'dark', statusPreset: null, desktop: true },
    'eink': { scheme: 'light', statusPreset: 'eink', desktop: true },
    'nord': { scheme: 'dark', statusPreset: 'nord', desktop: true },
    'sepia': { scheme: 'light', statusPreset: 'sepia', desktop: true },
    'material3-light': { scheme: 'light', statusPreset: null, desktop: false },
    'material3-dark': { scheme: 'dark', statusPreset: null, desktop: false },
    'oled': { scheme: 'dark', statusPreset: 'oled', desktop: true },
    'system-oled': { scheme: 'system', statusPreset: null, desktop: true },
    'catppuccin-macchiato': { scheme: 'dark', statusPreset: 'catppuccin-macchiato', desktop: true },
    'dracula': { scheme: 'dark', statusPreset: 'dracula', desktop: true },
    'gruvbox-light': { scheme: 'light', statusPreset: 'gruvbox-light', desktop: true },
    'gruvbox-dark': { scheme: 'dark', statusPreset: 'gruvbox-dark', desktop: true },
} as const satisfies Record<Exclude<AppTheme, 'system'>, ThemeDescriptor>;


const DESCRIPTOR_BY_THEME = new Map<string, ThemeDescriptor>(Object.entries(THEME_DESCRIPTORS));


export function themeDescriptor(theme: string | null | undefined): ThemeDescriptor | undefined {
    return theme ? DESCRIPTOR_BY_THEME.get(theme) : undefined;
}


export function resolveThemeColorScheme(theme: AppTheme, systemScheme: ThemeColorScheme): ThemeColorScheme {
    const scheme = themeDescriptor(theme)?.scheme;
    return scheme === 'light' || scheme === 'dark' ? scheme : systemScheme;
}

export function resolveThemeStatusPreset(theme: AppTheme, systemScheme: ThemeColorScheme): ThemeStatusPreset | null {
    if (theme === 'system-oled') return systemScheme === 'dark' ? 'oled' : null;
    return themeDescriptor(theme)?.statusPreset ?? null;
}

const TASK_STATUSES: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];


export const tone = (hex: string): StatusColorSet => ({ bg: `${hex}26`, text: hex, border: hex });

const buildPalette = (hues: Record<TaskStatus, string>): StatusPalette => {
    const palette = {} as StatusPalette;
    for (const status of TASK_STATUSES) palette[status] = tone(hues[status]);
    return palette;
};


export const STATUS_COLORS: StatusPalette = {
    'inbox': { bg: '#6B728020', text: '#6B7280', border: '#6B7280' },
    'next': { bg: '#3B82F620', text: '#2563EB', border: '#2563EB' },
    'waiting': { bg: '#F59E0B20', text: '#F59E0B', border: '#F59E0B' },
    'someday': { bg: '#8B5CF620', text: '#8B5CF6', border: '#8B5CF6' },
    'reference': { bg: '#0EA5E920', text: '#0EA5E9', border: '#0EA5E9' },
    'done': { bg: '#22C55E20', text: '#22C55E', border: '#22C55E' },
    'archived': { bg: '#6B728020', text: '#6B7280', border: '#6B7280' },
};

export function getStatusColor(status: TaskStatus): StatusColorSet {
    return STATUS_COLORS[status] || STATUS_COLORS['inbox'];
}

const DARK_STATUS_COLORS = buildPalette({
    inbox: '#9CA3AF',
    next: '#60A5FA',
    waiting: '#FBBF24',
    someday: '#A78BFA',
    reference: '#38BDF8',
    done: '#4ADE80',
    archived: '#9CA3AF',
});


const NORD_STATUS_COLORS = buildPalette({
    inbox: '#81A1C1',
    next: '#88C0D0',
    waiting: '#EBCB8B',
    someday: '#B48EAD',
    reference: '#8FBCBB',
    done: '#A3BE8C',
    archived: '#81A1C1',
});


const SEPIA_STATUS_COLORS = buildPalette({
    inbox: '#9C6F3C',
    next: '#509550',
    waiting: '#C38E22',
    someday: '#8C5EBA',
    reference: '#2E8CB8',
    done: '#725A5A',
    archived: '#9C6F3C',
});


const CATPPUCCIN_MACCHIATO_STATUS_COLORS = buildPalette({
    inbox: '#939ab7',
    next: '#8aadf4',
    waiting: '#eed49f',
    someday: '#c6a0f6',
    reference: '#91d7e3',
    done: '#a6da95',
    archived: '#939ab7',
});


const DRACULA_STATUS_COLORS = buildPalette({


    inbox: '#adb5cb',
    next: '#bd93f9',
    waiting: '#ffb86c',
    someday: '#ff79c6',
    reference: '#8be9fd',
    done: '#50fa7b',
    archived: '#adb5cb',
});


const GRUVBOX_LIGHT_STATUS_COLORS = buildPalette({
    inbox: '#504945',
    next: '#075f70',
    waiting: '#af3a03',
    someday: '#8f3f71',
    reference: '#3d7151',
    done: '#665c54',
    archived: '#504945',
});


const GRUVBOX_DARK_STATUS_COLORS = buildPalette({
    inbox: '#a89984',
    next: '#9eb9ae',
    waiting: '#fabd2f',
    someday: '#d3869b',
    reference: '#8ec07c',
    done: '#b8bb26',
    archived: '#a89984',
});

const EINK_STATUS_COLORS = buildPalette({
    inbox: '#000000',
    next: '#000000',
    waiting: '#000000',
    someday: '#000000',
    reference: '#000000',
    done: '#000000',
    archived: '#000000',
});


export const STATUS_COLORS_BY_THEME: Record<ThemeStatusPreset | ThemeColorScheme, StatusPalette> = {
    light: STATUS_COLORS,
    dark: DARK_STATUS_COLORS,
    nord: NORD_STATUS_COLORS,
    sepia: SEPIA_STATUS_COLORS,
    eink: EINK_STATUS_COLORS,
    oled: DARK_STATUS_COLORS,
    'catppuccin-macchiato': CATPPUCCIN_MACCHIATO_STATUS_COLORS,
    dracula: DRACULA_STATUS_COLORS,
    'gruvbox-light': GRUVBOX_LIGHT_STATUS_COLORS,
    'gruvbox-dark': GRUVBOX_DARK_STATUS_COLORS,
};
