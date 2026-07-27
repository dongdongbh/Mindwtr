import { describe, expect, it } from 'vitest';
import { loadStoredLanguageSync, resolveLanguageFromLocale } from './i18n-storage';

describe('i18n-storage locale defaults', () => {
    it('maps well-supported system locales to app language', () => {
        expect(resolveLanguageFromLocale('en-US')).toBe('en');
        expect(resolveLanguageFromLocale('zh-CN')).toBe('zh');
        expect(resolveLanguageFromLocale('zh-TW')).toBe('zh-Hant');
        expect(resolveLanguageFromLocale('zh-Hant-HK')).toBe('zh-Hant');
        expect(resolveLanguageFromLocale('es-ES')).toBe('es');
        expect(resolveLanguageFromLocale('ko-KR')).toBe('ko');
    });

    it('falls back to english for partially supported locales', () => {
        expect(resolveLanguageFromLocale('fr-FR')).toBe('en');
        expect(resolveLanguageFromLocale('de-DE')).toBe('en');
        expect(resolveLanguageFromLocale('pl-PL')).toBe('en');
    });

    it('uses locale fallback when no stored language exists', () => {
        const storage = {
            getItem: () => null,
            setItem: () => undefined,
        };
        expect(loadStoredLanguageSync(storage, resolveLanguageFromLocale('es-MX'))).toBe('es');
        expect(loadStoredLanguageSync(storage, resolveLanguageFromLocale('fr-FR'))).toBe('en');
    });
});
