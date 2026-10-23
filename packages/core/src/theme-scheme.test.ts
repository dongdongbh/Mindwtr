import { describe, expect, it } from 'vitest';
import { SETTINGS_THEME_VALUES } from './settings-options';
import {
    resolveThemeColorScheme,
    themeDescriptor,
    STATUS_COLORS_BY_THEME,
    THEME_DESCRIPTORS,
    getStatusColor,
    type ThemeColorScheme,
} from './theme-scheme';
import type { AppTheme, TaskStatus } from './types';

const TASK_STATUSES: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];
const CONCRETE_THEMES = SETTINGS_THEME_VALUES.filter((theme): theme is Exclude<AppTheme, 'system'> => theme !== 'system');
const FIXED_THEMES = CONCRETE_THEMES.filter((theme): theme is Exclude<AppTheme, 'system' | 'system-oled'> => theme !== 'system-oled');

// The one place the intended light/dark split is stated independently of the
// registry — without it the tests below would only prove the registry agrees
// with itself. A theme missing here has no expected scheme, so the loop fails.
const EXPECTED_SCHEMES: Record<Exclude<AppTheme, 'system' | 'system-oled'>, ThemeColorScheme> = {
    'light': 'light',
    'dark': 'dark',
    'eink': 'light',
    'nord': 'dark',
    'sepia': 'light',
    'material3-light': 'light',
    'material3-dark': 'dark',
    'oled': 'dark',
    'catppuccin-macchiato': 'dark',
    'dracula': 'dark',
    'gruvbox-light': 'light',
    'gruvbox-dark': 'dark',
};

describe('resolveThemeColorScheme', () => {
    it('classifies every concrete theme regardless of system scheme', () => {
        for (const theme of FIXED_THEMES) {
            expect(resolveThemeColorScheme(theme, 'light')).toBe(EXPECTED_SCHEMES[theme]);
            expect(resolveThemeColorScheme(theme, 'dark')).toBe(EXPECTED_SCHEMES[theme]);
        }
    });

    it('defers to systemScheme for system', () => {
        expect(resolveThemeColorScheme('system', 'dark')).toBe('dark');
        expect(resolveThemeColorScheme('system', 'light')).toBe('light');
        expect(resolveThemeColorScheme('system-oled', 'dark')).toBe('dark');
        expect(resolveThemeColorScheme('system-oled', 'light')).toBe('light');
    });
});

describe('themeDescriptor', () => {
    it('describes every concrete theme and nothing else', () => {
        for (const theme of CONCRETE_THEMES) {
            expect(themeDescriptor(theme)).toBe(THEME_DESCRIPTORS[theme]);
        }
        // 'system' has no fixed identity, and stored preferences are untrusted
        // strings — both must read as "not a theme" rather than as a default.
        expect(themeDescriptor('system')).toBeUndefined();
        expect(themeDescriptor('draculaa')).toBeUndefined();
        expect(themeDescriptor(undefined)).toBeUndefined();
        // Inherited Object.prototype keys must not read as themes.
        expect(themeDescriptor('constructor')).toBeUndefined();
        expect(themeDescriptor('toString')).toBeUndefined();
    });

    it('points every theme at a status palette that exists', () => {
        for (const theme of CONCRETE_THEMES) {
            const { statusPreset } = THEME_DESCRIPTORS[theme];
            expect(STATUS_COLORS_BY_THEME[statusPreset ?? resolveThemeColorScheme(theme, 'light')]).toBeDefined();
        }
    });
});

describe('STATUS_COLORS_BY_THEME', () => {
    it('resolves every theme x status pair to a defined color, including archived and oled', () => {
        for (const key of Object.keys(STATUS_COLORS_BY_THEME) as (keyof typeof STATUS_COLORS_BY_THEME)[]) {
            for (const status of TASK_STATUSES) {
                const color = STATUS_COLORS_BY_THEME[key][status];
                expect(color.bg).toBeTruthy();
                expect(color.text).toBeTruthy();
                expect(color.border).toBeTruthy();
            }
        }
    });

    it('keeps light identical to getStatusColor (unchanged public API)', () => {
        for (const status of TASK_STATUSES) {
            expect(STATUS_COLORS_BY_THEME.light[status]).toEqual(getStatusColor(status));
        }
    });

    it('derives oled from dark rather than a bespoke palette', () => {
        expect(STATUS_COLORS_BY_THEME.oled).toEqual(STATUS_COLORS_BY_THEME.dark);
    });

    it('gives catppuccin-macchiato and dracula bespoke hues drawn from their own palettes', () => {
        expect(STATUS_COLORS_BY_THEME['catppuccin-macchiato'].next.text).toBe('#8aadf4');
        expect(STATUS_COLORS_BY_THEME['catppuccin-macchiato'].someday.text).toBe('#c6a0f6');
        expect(STATUS_COLORS_BY_THEME['catppuccin-macchiato'].done.text).toBe('#a6da95');
        expect(STATUS_COLORS_BY_THEME.dracula.next.text).toBe('#bd93f9');
        expect(STATUS_COLORS_BY_THEME.dracula.reference.text).toBe('#8be9fd');
        expect(STATUS_COLORS_BY_THEME.dracula.done.text).toBe('#50fa7b');
    });

    it('gives the gruvbox themes their own palette hues, with reference darkened only in light', () => {
        expect(STATUS_COLORS_BY_THEME['gruvbox-light'].next.text).toBe('#075f70');
        expect(STATUS_COLORS_BY_THEME['gruvbox-light'].reference.text).toBe('#3d7151');
        expect(STATUS_COLORS_BY_THEME['gruvbox-light'].done.text).toBe('#665c54');
        expect(STATUS_COLORS_BY_THEME['gruvbox-dark'].next.text).toBe('#9eb9ae');
        expect(STATUS_COLORS_BY_THEME['gruvbox-dark'].reference.text).toBe('#8ec07c');
        expect(STATUS_COLORS_BY_THEME['gruvbox-dark'].done.text).toBe('#b8bb26');
    });

    it('keeps every status distinguishable within each new theme', () => {
        for (const key of ['catppuccin-macchiato', 'dracula', 'gruvbox-light', 'gruvbox-dark'] as const) {
            // archived deliberately mirrors inbox, as it does in every other theme.
            const hues = TASK_STATUSES.filter((status) => status !== 'archived')
                .map((status) => STATUS_COLORS_BY_THEME[key][status].text);
            expect(new Set(hues).size).toBe(hues.length);
            expect(STATUS_COLORS_BY_THEME[key].archived).toEqual(STATUS_COLORS_BY_THEME[key].inbox);
        }
    });
});
