import { describe, expect, it } from 'vitest';
import { arOverrides } from './locales/ar';
import { csOverrides } from './locales/cs';
import { deOverrides } from './locales/de';
import { en } from './locales/en';
import { esOverrides } from './locales/es';
import { frOverrides } from './locales/fr';
import { hiOverrides } from './locales/hi';
import { itOverrides } from './locales/it';
import { jaOverrides } from './locales/ja';
import { koOverrides } from './locales/ko';
import { nlOverrides } from './locales/nl';
import { plOverrides } from './locales/pl';
import { ptOverrides } from './locales/pt';
import { ruOverrides } from './locales/ru';
import { trOverrides } from './locales/tr';
import { viOverrides } from './locales/vi';
import { zhHans } from './locales/zh-Hans';
import { zhHant } from './locales/zh-Hant';
import { allowedEnglishMirrorKeysByLocale, hasTranslatableEnglishText, isAllowedEnglishMirrorKey } from './locale-quality';

const fullParityLocales: Record<string, Record<string, string>> = {
    zh: zhHans,
    'zh-Hant': zhHant,
};

const overrideLocales: Record<string, Record<string, string>> = {
    ar: arOverrides,
    cs: csOverrides,
    de: deOverrides,
    es: esOverrides,
    fr: frOverrides,
    hi: hiOverrides,
    it: itOverrides,
    ja: jaOverrides,
    ko: koOverrides,
    nl: nlOverrides,
    pl: plOverrides,
    pt: ptOverrides,
    ru: ruOverrides,
    tr: trOverrides,
    vi: viOverrides,
};

const nonLatinOverrideLocales: Record<string, Record<string, string>> = {
    ar: arOverrides,
    hi: hiOverrides,
    ja: jaOverrides,
    ko: koOverrides,
    ru: ruOverrides,
};

const overrideLocaleCoverageFloors: Record<string, number> = {
    ar: 69,
    cs: 99,
    de: 71,
    es: 64,
    fr: 70,
    hi: 69,
    it: 77,
    ja: 69,
    ko: 68,
    nl: 22,
    pl: 70,
    pt: 71,
    ru: 69,
    tr: 71,
    vi: 99,
};

const shippedLocales: Record<string, Record<string, string>> = {
    ...fullParityLocales,
    ...overrideLocales,
};

describe('locale parity', () => {
    it('keeps full-translation locales in key parity with English', () => {
        const englishKeys = Object.keys(en);

        for (const [language, translations] of Object.entries(fullParityLocales)) {
            const missing = englishKeys.filter((key) => !translations[key]);
            expect(missing, `Missing translations in ${language}`).toEqual([]);
        }
    });

    it('keeps partial override locale coverage from silently regressing', () => {
        const englishKeyCount = Object.keys(en).length;

        for (const [language, translations] of Object.entries(overrideLocales)) {
            const floor = overrideLocaleCoverageFloors[language];
            const coverage = (Object.keys(translations).length / englishKeyCount) * 100;
            expect(coverage, `${language} override coverage`).toBeGreaterThanOrEqual(floor);
        }
    });

    it('keeps shipped locales limited to known English keys', () => {
        const englishKeys = new Set(Object.keys(en));

        for (const [language, translations] of Object.entries(shippedLocales)) {
            const unknown = Object.keys(translations).filter((key) => !englishKeys.has(key));
            expect(unknown, `Unknown translation keys in ${language}`).toEqual([]);
        }
    });

    it('does not hide untranslated copy behind verbatim English placeholders', () => {
        for (const [language, translations] of Object.entries(shippedLocales)) {
            const placeholders = Object.keys(translations).filter((key) => (
                translations[key] === en[key]
                && hasTranslatableEnglishText(en[key])
                && !isAllowedEnglishMirrorKey(language, key)
            ));
            expect(placeholders, `Verbatim English placeholders in ${language}`).toEqual([]);
        }
    });

    it('keeps mirrored-English allow-lists limited to reviewed matching keys', () => {
        for (const [language, allowedKeys] of Object.entries(allowedEnglishMirrorKeysByLocale)) {
            const translations = shippedLocales[language];
            expect(translations, `Known locale for mirrored-English allow-list ${language}`).toBeDefined();

            const staleKeys = allowedKeys.filter((key) => (
                !translations?.[key] || translations[key] !== en[key] || !hasTranslatableEnglishText(en[key])
            ));
            expect(staleKeys, `Stale mirrored-English allow-list keys in ${language}`).toEqual([]);
        }
    });

    it('uses named interpolation slots in English source strings', () => {
        const positionalPlaceholders = Object.keys(en).filter((key) => /\{\{\s*value\d+\s*\}\}/.test(en[key]));
        expect(positionalPlaceholders).toEqual([]);
    });

    it('keeps generated placeholder fragments out of source key names', () => {
        const generatedKeys = Object.keys(en).filter((key) => /(?:vValue|ValueValue|Value\d)/.test(key));
        expect(generatedKeys).toEqual([]);
    });

    it('does not ship mixed English fragments in non-Latin partial locales', () => {
        for (const [language, translations] of Object.entries(nonLatinOverrideLocales)) {
            const mixedEnglish = Object.keys(translations).filter((key) => (
                hasTranslatableEnglishText(translations[key])
            ));
            expect(mixedEnglish, `Mixed English fragments in ${language}`).toEqual([]);
        }
    });
});
