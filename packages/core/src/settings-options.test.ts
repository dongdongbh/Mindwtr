import { describe, it, expect } from 'vitest';
import { SETTINGS_DENSITY_VALUES, SETTINGS_DENSITY_VALUE_SET, SETTINGS_THEME_VALUES } from './settings-options';
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
