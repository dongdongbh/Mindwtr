import { describe, expect, it } from 'vitest';

import {
    CATPPUCCIN_MACCHIATO_EXTERNAL_CALENDAR_COLOR_MAP,
    DRACULA_EXTERNAL_CALENDAR_COLOR_MAP,
    EXTERNAL_CALENDAR_COLORS,
    getExternalCalendarColorForId,
    hasExplicitExternalCalendarColor,
    normalizeDerivedIcsColor,
    normalizeExternalCalendarColor,
    NORD_EXTERNAL_CALENDAR_COLOR_MAP,
    resolveExternalCalendarColor,
    themeExternalCalendarDisplayColor,
} from './external-calendar-colors';

describe('external calendar colors', () => {
    it('normalizes only supported palette colors', () => {
        expect(normalizeExternalCalendarColor('#2563eb')).toBe('#2563EB');
        expect(normalizeExternalCalendarColor('#000000')).toBeUndefined();
        expect(normalizeExternalCalendarColor('red')).toBeUndefined();
        expect(normalizeExternalCalendarColor(null)).toBeUndefined();
    });

    it('returns a stable palette color for a source id', () => {
        const color = getExternalCalendarColorForId('work');
        expect(EXTERNAL_CALENDAR_COLORS).toContain(color);
        expect(getExternalCalendarColorForId('work')).toBe(color);
    });

    it('normalizes any hex color for feed-derived values, unlike the strict swatch validator', () => {
        expect(normalizeDerivedIcsColor('#abc')).toBe('#AABBCC');
        expect(normalizeDerivedIcsColor('123456')).toBe('#123456');
        expect(normalizeDerivedIcsColor('#FF008077')).toBe('#FF0080');
        expect(normalizeDerivedIcsColor('not-hex')).toBeUndefined();
        expect(normalizeDerivedIcsColor(undefined)).toBeUndefined();
    });

    it('resolves with precedence: user pick > feed color > hash', () => {
        const sourceId = 'work-calendar';
        const hash = getExternalCalendarColorForId(sourceId);


        expect(resolveExternalCalendarColor(sourceId)).toBe(hash);


        expect(resolveExternalCalendarColor(sourceId, undefined, '#123456')).toBe('#123456');


        expect(resolveExternalCalendarColor(sourceId, '#2563EB', '#123456')).toBe('#2563EB');


        expect(resolveExternalCalendarColor(sourceId, undefined, 'not-a-color')).toBe(hash);
    });

    it('treats a stored color equal to the hash default as auto-assigned, not an explicit pick (#974)', () => {
        const sourceId = 'legacy-calendar';
        const hash = getExternalCalendarColorForId(sourceId);


        expect(resolveExternalCalendarColor(sourceId, hash, '#123456')).toBe('#123456');


        expect(resolveExternalCalendarColor(sourceId, hash, undefined)).toBe(hash);


        const otherSwatch = EXTERNAL_CALENDAR_COLORS.find((color) => color !== hash)!;
        expect(resolveExternalCalendarColor(sourceId, otherSwatch, '#123456')).toBe(otherSwatch);
    });

    it('reports whether a stored color counts as a deliberate pick (#974)', () => {
        const sourceId = 'some-calendar';
        const hash = getExternalCalendarColorForId(sourceId);
        const otherSwatch = EXTERNAL_CALENDAR_COLORS.find((color) => color !== hash)!;


        expect(hasExplicitExternalCalendarColor(sourceId)).toBe(false);
        expect(hasExplicitExternalCalendarColor(sourceId, hash)).toBe(false);
        expect(hasExplicitExternalCalendarColor(sourceId, otherSwatch)).toBe(true);


        expect(resolveExternalCalendarColor(sourceId, otherSwatch, '#123456')).toBe(otherSwatch);
        expect(resolveExternalCalendarColor(sourceId, hash, '#123456')).toBe('#123456');
    });
});

describe('themeExternalCalendarDisplayColor', () => {
    it('remaps a pickable swatch under nord, case-insensitively', () => {
        expect(themeExternalCalendarDisplayColor('#2563eb', 'nord')).toBe('#5e81ac');

        expect(themeExternalCalendarDisplayColor('#2563EB', 'nord')).toBe('#5e81ac');
    });

    it.each(['nord', 'catppuccin-macchiato', 'dracula', 'gruvbox-light', 'gruvbox-dark'])(
        'covers all 8 pickable swatches with distinct colors under %s',
        (theme) => {
            const mapped = EXTERNAL_CALENDAR_COLORS.map((color) => themeExternalCalendarDisplayColor(color, theme));
            expect(mapped).not.toContain(undefined);
            expect(mapped.every((color, index) => color !== EXTERNAL_CALENDAR_COLORS[index])).toBe(true);
            expect(new Set(mapped).size).toBe(EXTERNAL_CALENDAR_COLORS.length);
        },
    );

    it('keys every themed map on the full pickable swatch set', () => {
        expect(Object.keys(NORD_EXTERNAL_CALENDAR_COLOR_MAP)).toHaveLength(EXTERNAL_CALENDAR_COLORS.length);
        expect(Object.keys(CATPPUCCIN_MACCHIATO_EXTERNAL_CALENDAR_COLOR_MAP)).toHaveLength(EXTERNAL_CALENDAR_COLORS.length);
        expect(Object.keys(DRACULA_EXTERNAL_CALENDAR_COLOR_MAP)).toHaveLength(EXTERNAL_CALENDAR_COLORS.length);
    });

    it('passes an unmapped color through — a feed COLOR hint is arbitrary hex', () => {
        expect(themeExternalCalendarDisplayColor('#123456', 'nord')).toBe('#123456');
    });

    it('is the identity on every other theme', () => {
        for (const theme of [undefined, 'dark', 'light', 'sepia', 'oled']) {
            expect(themeExternalCalendarDisplayColor('#2563EB', theme)).toBe('#2563EB');
        }
    });

    it('draws everything black on eink — the display is monochrome and a feed COLOR hint is arbitrary hex', () => {
        for (const color of EXTERNAL_CALENDAR_COLORS) {
            expect(themeExternalCalendarDisplayColor(color, 'eink')).toBe('#000000');
        }
        expect(themeExternalCalendarDisplayColor('#123456', 'eink')).toBe('#000000');
        expect(themeExternalCalendarDisplayColor('#2563EB', 'eink')).toBe('#000000');
    });

    it('never changes what resolution or the explicit-pick rule report', () => {
        const sourceId = 'work';
        const hash = getExternalCalendarColorForId(sourceId);
        const otherSwatch = EXTERNAL_CALENDAR_COLORS.find((color) => color !== hash)!;


        expect(resolveExternalCalendarColor(sourceId, otherSwatch)).toBe(otherSwatch);
        expect(hasExplicitExternalCalendarColor(sourceId, otherSwatch)).toBe(true);
        expect(themeExternalCalendarDisplayColor(otherSwatch, 'nord')).not.toBe(otherSwatch);
    });
});
