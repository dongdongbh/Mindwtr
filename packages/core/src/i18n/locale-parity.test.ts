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
import { LOCALES, MIXED_ENGLISH_COVERAGE_CEILING, type Locale } from './i18n-locales';

// The one hand-kept binding left in this file: LOCALES (i18n-locales.ts) describes each
// locale's mode/coverageFloor/nonLatin, but the concrete translation object still has to come
// from a real static import — there's no way to turn a string key into an imported binding
// without one. Every other roster this file used to hand-keep (fullParityLocales,
// overrideLocales, nonLatinOverrideLocales, overrideLocaleCoverageFloors, shippedLocales) was
// an independent list of the same locale set and is now derived from LOCALES below.
const translationsByLocale: Record<Locale, Record<string, string>> = {
    zh: zhHans, 'zh-Hant': zhHant,
    ar: arOverrides, cs: csOverrides, de: deOverrides, es: esOverrides, fr: frOverrides,
    hi: hiOverrides, it: itOverrides, ja: jaOverrides, ko: koOverrides, nl: nlOverrides,
    pl: plOverrides, pt: ptOverrides, ru: ruOverrides, tr: trOverrides, vi: viOverrides,
};

const locales = Object.entries(LOCALES) as Array<[Locale, (typeof LOCALES)[Locale]]>;
const fullParityLocales = locales.filter(([, descriptor]) => descriptor.mode === 'full');
const overrideLocales = locales.filter(([, descriptor]) => descriptor.mode === 'overrides');
const nonLatinOverrideLocales = overrideLocales.filter(([, descriptor]) => (
    descriptor.nonLatin && descriptor.coverageFloor < MIXED_ENGLISH_COVERAGE_CEILING
));

describe('locale parity', () => {
    it.each(fullParityLocales)('keeps %s in full key parity with English', (lang) => {
        const englishKeys = Object.keys(en);
        const missing = englishKeys.filter((key) => !translationsByLocale[lang][key]);
        expect(missing).toEqual([]);
    });

    it.each(overrideLocales)('keeps %s override coverage from silently regressing', (lang, descriptor) => {
        const englishKeyCount = Object.keys(en).length;
        const coverage = (Object.keys(translationsByLocale[lang]).length / englishKeyCount) * 100;
        expect(coverage).toBeGreaterThanOrEqual(descriptor.coverageFloor);
    });

    it.each(locales)('keeps promoted task action labels translated in %s', (lang) => {
        const taskActionKeys = [
            'task.createProjectFromTask',
            'task.duplicateFailed',
            'task.promoteToProjectFailed',
        ];
        const missing = taskActionKeys.filter((key) => !translationsByLocale[lang][key]);
        expect(missing).toEqual([]);
    });

    it.each(locales)('keeps desktop search scope hint translated in %s', (lang) => {
        expect(translationsByLocale[lang]['search.scopeHint']).toBeTruthy();
    });

    it.each(locales)('keeps %s limited to known English keys', (lang) => {
        const englishKeys = new Set(Object.keys(en));
        const unknown = Object.keys(translationsByLocale[lang]).filter((key) => !englishKeys.has(key));
        expect(unknown).toEqual([]);
    });

    it.each(locales)('does not hide untranslated copy behind verbatim English placeholders in %s', (lang) => {
        const translations = translationsByLocale[lang];
        const placeholders = Object.keys(translations).filter((key) => (
            translations[key] === en[key]
            && hasTranslatableEnglishText(en[key])
            && !isAllowedEnglishMirrorKey(lang, key)
        ));
        expect(placeholders).toEqual([]);
    });

    it('keeps mirrored-English allow-lists limited to reviewed matching keys', () => {
        for (const [language, allowedKeys] of Object.entries(allowedEnglishMirrorKeysByLocale)) {
            const translations = translationsByLocale[language as Locale];
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

    it.each(nonLatinOverrideLocales)('does not ship mixed English fragments in %s', (lang) => {
        const translations = translationsByLocale[lang];
        const mixedEnglish = Object.keys(translations).filter((key) => hasTranslatableEnglishText(translations[key]));
        expect(mixedEnglish).toEqual([]);
    });
});
