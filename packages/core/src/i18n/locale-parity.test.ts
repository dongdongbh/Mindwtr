import { describe, expect, it } from 'vitest';
import { arOverrides } from './locales/ar';
import { csOverrides } from './locales/cs';
import { deOverrides } from './locales/de';
import { en } from './locales/en';
import { esOverrides } from './locales/es';
import { faOverrides } from './locales/fa';
import { frOverrides } from './locales/fr';
import { hiOverrides } from './locales/hi';
import { itOverrides } from './locales/it';
import { jaOverrides } from './locales/ja';
import { koOverrides } from './locales/ko';
import { nlOverrides } from './locales/nl';
import { plOverrides } from './locales/pl';
import { ptOverrides } from './locales/pt';
import { ruOverrides } from './locales/ru';
import { svOverrides } from './locales/sv';
import { trOverrides } from './locales/tr';
import { viOverrides } from './locales/vi';
import { zhHans } from './locales/zh-Hans';
import { zhHant } from './locales/zh-Hant';
import { allowedEnglishMirrorKeysByLocale, hasTranslatableEnglishText, isAllowedEnglishMirrorKey } from './locale-quality';
import { i18nTemplateSlots } from './index';
import { LOCALES, isMixedEnglishChecked, type Locale } from './i18n-locales';

// The one hand-kept binding left in this file: LOCALES (i18n-locales.ts) describes each
// locale's mode/translatedKeyFloor/nonLatin, but the concrete translation object still has to come
// from a real static import — there's no way to turn a string key into an imported binding
// without one. Every other roster this file used to hand-keep (fullParityLocales,
// overrideLocales, nonLatinOverrideLocales, overrideLocaleCoverageFloors, shippedLocales) was
// an independent list of the same locale set and is now derived from LOCALES below.
const translationsByLocale: Record<Locale, Record<string, string>> = {
    zh: zhHans, 'zh-Hant': zhHant,
    ar: arOverrides, cs: csOverrides, de: deOverrides, es: esOverrides, fa: faOverrides, fr: frOverrides,
    hi: hiOverrides, it: itOverrides, ja: jaOverrides, ko: koOverrides, nl: nlOverrides,
    pl: plOverrides, pt: ptOverrides, ru: ruOverrides, sv: svOverrides, tr: trOverrides, vi: viOverrides,
};

const englishKeyCount = Object.keys(en).length;
const locales = Object.entries(LOCALES) as Array<[Locale, (typeof LOCALES)[Locale]]>;
// Full parity is the 'all' commitment, not the load mode: fa and sv load as 'overrides' but
// are maintained at every key (see i18n-locales.ts).
const fullParityLocales = locales.filter(([, descriptor]) => descriptor.translatedKeyFloor === 'all');
const countFloorLocales = locales.filter(([, descriptor]) => typeof descriptor.translatedKeyFloor === 'number');
const nonLatinOverrideLocales = locales.filter(([, descriptor]) => isMixedEnglishChecked(descriptor, englishKeyCount));
const recoverySettingsKeys = [
    'onboarding.startFreshTitle',
    'onboarding.toastNotCreated',
    'onboarding.toastReady',
    'onboarding.toastFailed',
    'settings.gettingStartedContentAction',
    'settings.gettingStartedContentDesc',
    'settings.gettingStartedContentConfirmTitle',
    'settings.gettingStartedContentConfirmDesc',
    'settings.gettingStartedContentConfirm',
    'settings.gettingStartedContentContinueTitle',
    'settings.gettingStartedContentContinueDesc',
    'settings.syncSetupGuideTitle',
    'settings.syncSetupGuideDesc',
    'settings.importSetupGuideTitle',
    'settings.importSetupGuideDesc',
] as const;

describe('locale parity', () => {
    it.each(fullParityLocales)('keeps %s in full key parity with English', (lang) => {
        const englishKeys = Object.keys(en);
        const missing = englishKeys.filter((key) => !translationsByLocale[lang][key]);
        expect(missing).toEqual([]);
    });

    it.each(countFloorLocales)('keeps %s translated-key count from silently regressing', (lang, descriptor) => {
        const translatedKeys = Object.keys(translationsByLocale[lang]).length;
        const coverage = ((translatedKeys / englishKeyCount) * 100).toFixed(1);
        // The floor is a count, not a percentage, so growing en.ts can never fail this — only
        // deleting a translation can. The percentage is still worth seeing, so report it here.
        expect(
            translatedKeys,
            `${lang} translates ${translatedKeys} of ${englishKeyCount} English keys (${coverage}%); floor is ${descriptor.translatedKeyFloor}. Raise the floor in i18n-locales.ts when translations land; never lower it.`,
        ).toBeGreaterThanOrEqual(descriptor.translatedKeyFloor as number);
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

    it('defines the recovery settings copy in English', () => {
        const missing = recoverySettingsKeys.filter((key) => !en[key]);
        expect(missing).toEqual([]);
    });

    it.each(locales)('keeps recovery settings copy translated in %s', (lang) => {
        const missing = recoverySettingsKeys.filter((key) => !translationsByLocale[lang][key]);
        expect(missing).toEqual([]);
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

    // A translation can be fluent, idiomatic, reviewed, and still silently broken if it drops
    // an interpolation slot: `calendar.searchMatches` rendered as "Suchtreffer" instead of
    // "{count} Treffer in dieser Ansicht" loses the number with nothing to show for it, and no
    // other check here can see it — key presence passes, mixed-English passes, the mirrored-
    // English check passes because the value genuinely is German. Compared as SETS, so an
    // invented slot the English source does not have fails too: that one renders as literal
    // "{{whatever}}" on screen, because formatI18nTemplate leaves unknown names untouched.
    //
    // Both brace styles count, via the same pattern formatI18nTemplate fills them with, since
    // en.ts uses `{{count}}` for most keys and bare `{count}` for a handful.
    //
    // No allow-list: a slot is machinery, not prose. Word order around it is the translator's
    // to choose, and the slot itself is never the untranslatable part.
    it.each(locales)('keeps interpolation slots intact in %s', (lang) => {
        const translations = translationsByLocale[lang];
        const mismatched = Object.keys(translations)
            .filter((key) => key in en)
            .map((key) => ({
                key,
                english: i18nTemplateSlots(en[key]),
                translated: i18nTemplateSlots(translations[key]),
            }))
            .filter(({ english, translated }) => english.join(',') !== translated.join(','))
            .map(({ key, english, translated }) => (
                `${key}: en has [${english.join(', ')}], ${lang} has [${translated.join(', ')}]`
            ));
        expect(mismatched).toEqual([]);
    });

    it.each(nonLatinOverrideLocales)('does not ship mixed English fragments in %s', (lang) => {
        const translations = translationsByLocale[lang];
        const mixedEnglish = Object.keys(translations).filter((key) => hasTranslatableEnglishText(translations[key]));
        expect(mixedEnglish).toEqual([]);
    });
});
