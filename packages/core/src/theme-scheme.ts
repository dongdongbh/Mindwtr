/**
 * Single source of truth for "is this theme dark, and what colors does it use?"
 *
 * Desktop, mobile, and the iOS widget each need to answer this from an `AppTheme`
 * value (see types.ts) plus, for adaptive modes, the platform's actual light/dark
 * preference. Keep that classification here — do not re-derive it per platform.
 */
import type { AppTheme, TaskStatus } from './types';

export type ThemeColorScheme = 'light' | 'dark';

/** The themes with a bespoke, non-Material color identity. */
export type ThemeStatusPreset = 'eink' | 'nord' | 'sepia' | 'oled' | 'catppuccin-macchiato' | 'dracula' | 'gruvbox-light' | 'gruvbox-dark';

export type StatusColorSet = { bg: string; text: string; border: string };
export type StatusPalette = Record<TaskStatus, StatusColorSet>;

export type ThemeDescriptor = {
    /** Fixed scheme, or the platform preference for an adaptive theme. */
    scheme: ThemeColorScheme | 'system';
    /** Its bespoke status palette, or `null` to use the plain scheme palette. */
    statusPreset: ThemeStatusPreset | null;
    /** Whether desktop ships CSS for it; the rest collapse to `scheme` there. */
    desktop: boolean;
};

/**
 * Every named `AppTheme` and what each platform needs to know about it.
 * `satisfies Record<Exclude<AppTheme, 'system'>, …>` is the point: a twelfth
 * theme cannot compile until it has answered all three questions here, and the
 * desktop mode union, the mobile preset, and the dark/light classification are
 * all read off this one table instead of being hand-copied per platform.
 */
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

// A Map so inherited Object.prototype keys ('constructor', 'toString', …) in an
// untrusted stored string can never resolve to a descriptor.
const DESCRIPTOR_BY_THEME = new Map<string, ThemeDescriptor>(Object.entries(THEME_DESCRIPTORS));

/**
 * The descriptor for a named theme, or `undefined` for `'system'` and for
 * any value that isn't a theme (stored preferences are untrusted strings).
 */
export function themeDescriptor(theme: string | null | undefined): ThemeDescriptor | undefined {
    return theme ? DESCRIPTOR_BY_THEME.get(theme) : undefined;
}

/**
 * Resolves an `AppTheme` to the color scheme it renders in. `'system'` (and any
 * value this function doesn't recognize) defers to `systemScheme`.
 */
export function resolveThemeColorScheme(theme: AppTheme, systemScheme: ThemeColorScheme): ThemeColorScheme {
    const scheme = themeDescriptor(theme)?.scheme;
    return scheme === 'light' || scheme === 'dark' ? scheme : systemScheme;
}

export function resolveThemeStatusPreset(theme: AppTheme, systemScheme: ThemeColorScheme): ThemeStatusPreset | null {
    if (theme === 'system-oled') return systemScheme === 'dark' ? 'oled' : null;
    return themeDescriptor(theme)?.statusPreset ?? null;
}

const TASK_STATUSES: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];

/** Badge tone from a single hue: translucent background, solid text/border. */
export const tone = (hex: string): StatusColorSet => ({ bg: `${hex}26`, text: hex, border: hex });

const buildPalette = (hues: Record<TaskStatus, string>): StatusPalette => {
    const palette = {} as StatusPalette;
    for (const status of TASK_STATUSES) palette[status] = tone(hues[status]);
    return palette;
};

/**
 * Standard task colors for each status, tuned for light backgrounds.
 * Used for badges, borders, and highlights across the app.
 */
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

// Nord frost/aurora hues so badges sit inside the theme's own palette.
const NORD_STATUS_COLORS = buildPalette({
    inbox: '#81A1C1',
    next: '#88C0D0',
    waiting: '#EBCB8B',
    someday: '#B48EAD',
    reference: '#8FBCBB',
    done: '#A3BE8C',
    archived: '#81A1C1',
});

// Earthy tones on cream; mirrors desktop's sepia --status-* values.
const SEPIA_STATUS_COLORS = buildPalette({
    inbox: '#9C6F3C',
    next: '#509550',
    waiting: '#C38E22',
    someday: '#8C5EBA',
    reference: '#2E8CB8',
    done: '#725A5A',
    archived: '#9C6F3C',
});

// Catppuccin Macchiato accents. Inbox/archived take overlay2 rather than an
// accent: it is the palette's muted neutral and still clears 5:1 on `base`,
// where overlay1 lands under 4.5:1.
const CATPPUCCIN_MACCHIATO_STATUS_COLORS = buildPalette({
    inbox: '#939ab7',
    next: '#8aadf4',
    waiting: '#eed49f',
    someday: '#c6a0f6',
    reference: '#91d7e3',
    done: '#a6da95',
    archived: '#939ab7',
});

// Dracula accents. `next` takes purple (the theme's primary accent, same as
// Nord's `next` takes its tint), which frees cyan for `reference` and pink for
// `someday`; waiting takes orange because Dracula's yellow is a pale lime that
// reads as neither caution nor amber next to green.
const DRACULA_STATUS_COLORS = buildPalette({
    // Dracula's own de-emphasis color, `comment` (#6272a4), is 3.0:1 on the
    // theme background -- fine for the code comments it was drawn for, not for
    // a badge. This is comment blended 50/50 with `foreground` (#f8f8f2), the
    // same "official hue, mechanically adjusted for legibility" move
    // NORD_CONTEXT_COLOR_PALETTE's slot 8 makes.
    inbox: '#adb5cb',
    next: '#bd93f9',
    waiting: '#ffb86c',
    someday: '#ff79c6',
    reference: '#8be9fd',
    done: '#50fa7b',
    archived: '#adb5cb',
});

// Gruvbox light (soft, on bg0_s #f2e5bc). Every hue here clears 4.5:1 on the
// background and on the bg0 cards. Gruvbox's darkest aqua (#427b58) and green
// (#79740e) stop near 3.9:1, so `done` takes the fg3 gray (the desktop default
// and sepia themes already show done as a muted neutral), inbox/archived take
// fg2, and `reference` keeps aqua's hue and saturation with the lightness
// lowered only to 4.5:1. `next` is the faded blue darkened the same way so it
// clears 4.5:1 on its own chip tint.
const GRUVBOX_LIGHT_STATUS_COLORS = buildPalette({
    inbox: '#504945',
    next: '#075f70',
    waiting: '#af3a03',
    someday: '#8f3f71',
    reference: '#3d7151',
    done: '#665c54',
    archived: '#504945',
});

// Gruvbox dark (medium, on bg0 #282828). The bright accents and fg4 clear
// 4.5:1 on the background and on the bg0_s cards; `next` is the bright blue
// lightened so it also clears 4.5:1 on its own chip tint.
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

/**
 * Status badge palette for every theme scheme/preset mobile and desktop support.
 * `oled` has no bespoke hue set of its own — it's dark mode with a black
 * background, so it reuses `dark`'s palette rather than inventing new colors.
 */
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
