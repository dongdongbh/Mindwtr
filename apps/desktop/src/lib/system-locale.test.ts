import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureDateFormatting, createDateFormatter, getDateFormattingConfig, safeFormatDate } from '@mindwtr/core';
import { invokeNative } from './tauri-invoke';
import {
    getSystemDateFormatting,
    getSystemDefaultLocale,
    getSystemShortDatePattern,
    loadWindowsRegionalDate,
    syncDesktopDateFormatting,
    systemShortDateExample,
} from './system-locale';

vi.mock('./tauri-invoke', () => ({ invokeNative: vi.fn() }));

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

    it('uses the Windows short date even when the webview reports American English', async () => {
        const previousFormatting = getDateFormattingConfig();
        vi.mocked(invokeNative).mockResolvedValueOnce(['nl-NL', 'dd-MM-yyyy']);
        await loadWindowsRegionalDate();
        try {
            expect(invokeNative).toHaveBeenCalledWith('get_windows_regional_date');
            expect(getSystemDefaultLocale()).toBe('nl-NL');
            expect(getSystemShortDatePattern()).toBe('dd-MM-yyyy');
            expect(getSystemDateFormatting()).toEqual({ systemLocale: 'nl-NL', systemDateFormat: 'dd-MM-yyyy' });
            expect(createDateFormatter(getSystemDateFormatting())('2026-11-23', 'P')).toBe('23-11-2026');
            expect(syncDesktopDateFormatting({ language: 'en', dateFormat: 'system' })).toBe(true);
            expect(syncDesktopDateFormatting({ language: 'en', dateFormat: 'system' })).toBe(false);
            expect(safeFormatDate('2026-11-23', 'P')).toBe('23-11-2026');
            const date = new Date(2026, 10, 20);
            expect(systemShortDateExample(date)).toBe('20-11-2026');
            vi.mocked(invokeNative).mockRejectedValueOnce(new Error('unavailable'));
            await loadWindowsRegionalDate();
            expect(getSystemShortDatePattern()).toBeUndefined();
            expect(systemShortDateExample(date)).toBe(date.toLocaleDateString());
        } finally {
            configureDateFormatting(previousFormatting);
        }
    });

    it('uses the regional locale when the display language differs', () => {
        setNavigatorLocale('en-US', ['en-US']);
        const options = Intl.DateTimeFormat().resolvedOptions();
        vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, locale: 'pt-PT' });
        expect(getSystemDefaultLocale()).toBe('pt-PT');
    });

    it.each(['pt-PT', 'en-ZA', 'zh-HK', 'fi-FI', 'en-US'])('uses the regional preview pattern for %s in task dates', (locale) => {
        const date = new Date(2026, 0, 2);
        const options = Intl.DateTimeFormat().resolvedOptions();
        vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, locale });
        expect(createDateFormatter(getSystemDateFormatting())(date, 'P')).toBe(date.toLocaleDateString(locale));
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
