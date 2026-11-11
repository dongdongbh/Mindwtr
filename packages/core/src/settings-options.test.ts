import { describe, it, expect } from 'vitest';
import { isSettingsSyncGroupEnabled, SETTINGS_DENSITY_VALUES, SETTINGS_DENSITY_VALUE_SET, SETTINGS_THEME_VALUES } from './settings-options';
import type { SettingsSyncPreferences } from './types';
import { THEME_DESCRIPTORS } from './theme-scheme';

describe('settings theme options', () => {


    it('offers exactly the themes the descriptor registry describes, plus system', () => {
        expect([...SETTINGS_THEME_VALUES].sort()).toEqual(
            ['system', ...Object.keys(THEME_DESCRIPTORS)].sort(),
        );
    });
});

describe('settings density options', () => {
    it('exposes comfortable, compact, and condensed as valid density values', () => {
        expect(SETTINGS_DENSITY_VALUES).toEqual(
            expect.arrayContaining(['comfortable', 'compact', 'condensed']),
        );
    });

    it('accepts condensed in the density value set used by the merge sanitizer', () => {
        expect(SETTINGS_DENSITY_VALUE_SET.has('condensed')).toBe(true);
    });
});

describe('isSettingsSyncGroupEnabled', () => {
    const stored = (value: unknown): SettingsSyncPreferences => ({ gtd: value, appearance: value } as unknown as SettingsSyncPreferences);

    it('reads a stored boolean as written', () => {
        expect(isSettingsSyncGroupEnabled(stored(true), 'appearance')).toBe(true);
        expect(isSettingsSyncGroupEnabled(stored(false), 'gtd')).toBe(false);
    });

    it('keeps each group default for anything that is not a boolean', () => {
        for (const value of [undefined, null, 'true', 'false', 1, 0, {}]) {
            expect(isSettingsSyncGroupEnabled(stored(value), 'gtd')).toBe(true);
            expect(isSettingsSyncGroupEnabled(stored(value), 'appearance')).toBe(false);
        }
        expect(isSettingsSyncGroupEnabled(undefined, 'gtd')).toBe(true);
        expect(isSettingsSyncGroupEnabled(undefined, 'language')).toBe(false);
    });
});
