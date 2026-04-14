import { describe, expect, it } from 'vitest';

import { resolveNativeDateInputLocale } from './native-date-input-locale';

describe('resolveNativeDateInputLocale', () => {
    it('uses a Canadian English locale for english YMD overrides and preserves 24h + Monday preferences', () => {
        expect(resolveNativeDateInputLocale({
            language: 'en',
            dateFormat: 'ymd',
            timeFormat: '24h',
            weekStart: 'monday',
            systemLocale: 'en-US',
        })).toBe('en-CA-u-hc-h23-fw-mon');
    });

    it('uses a British English locale for english DMY overrides', () => {
        expect(resolveNativeDateInputLocale({
            language: 'en',
            dateFormat: 'dmy',
            timeFormat: 'system',
            weekStart: 'monday',
            systemLocale: 'en-US',
        })).toBe('en-GB-u-fw-mon');
    });

    it('keeps the system locale when the date format is system and only applies the explicit time override', () => {
        expect(resolveNativeDateInputLocale({
            language: 'en',
            dateFormat: 'system',
            timeFormat: '24h',
            weekStart: 'sunday',
            systemLocale: 'en-US',
        })).toBe('en-US-u-hc-h23-fw-sun');
    });
});
