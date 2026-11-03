import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSystemDefaultLocale } from './system-locale';

const originalLanguage = navigator.language;
const originalLanguages = navigator.languages;

const setNavigatorLocale = (language: string, languages: readonly string[]) => {
    Object.defineProperty(navigator, 'language', { value: language, configurable: true });
    Object.defineProperty(navigator, 'languages', { value: [...languages], configurable: true });
};

describe('getSystemDefaultLocale', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        setNavigatorLocale(originalLanguage, originalLanguages ?? [originalLanguage]);
    });

    it('uses the regional locale when the display language differs', () => {
        setNavigatorLocale('en-US', ['en-US']);
        const options = Intl.DateTimeFormat().resolvedOptions();
        vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, locale: 'pt-PT' });
        expect(getSystemDefaultLocale()).toBe('pt-PT');
    });

    it('falls back to the navigator locale when Intl is unavailable', () => {
        const originalDateTimeFormat = Intl.DateTimeFormat;
        setNavigatorLocale('pt-PT', ['pt-PT', 'en-US']);
        (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = undefined;
        try {
            expect(getSystemDefaultLocale()).toBe('pt-PT');
        } finally {
            (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = originalDateTimeFormat;
        }
    });

    it('returns an empty string when no locale source is available', () => {
        const originalDateTimeFormat = Intl.DateTimeFormat;
        (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = undefined;
        setNavigatorLocale('', []);
        try {
            expect(getSystemDefaultLocale()).toBe('');
        } finally {
            (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = originalDateTimeFormat;
        }
    });
});
