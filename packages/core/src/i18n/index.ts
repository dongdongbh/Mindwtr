export type { Language } from './i18n-types';
import { en } from './locales/en';
import { LOCALES, MIXED_ENGLISH_COVERAGE_CEILING, type LocaleDescriptor } from './i18n-locales';
import { getTranslationsSync } from './i18n-loader';
import { isSupportedLanguage } from './i18n-constants';

export type TranslateFn = (key: string) => string;

let englishTextToKey: Map<string, string> | null = null;

export function getI18nKeyForEnglishText(text: string): string | undefined {
    if (!englishTextToKey) {
        englishTextToKey = new Map();
        for (const [key, value] of Object.entries(en)) {
            if (englishTextToKey.has(value)) continue;
            englishTextToKey.set(value, key);
        }
    }
    return englishTextToKey.get(text);
}


export function getTranslator(language: string): TranslateFn {
    const translations = isSupportedLanguage(language) ? getTranslationsSync(language) : {};
    return (key: string) => translations[key] ?? en[key] ?? key;
}

export function getEnglishI18nValue(key: string): string | undefined {
    return en[key];
}


export function getLocaleCoverageTier(code: string): 'full' | 'partial' {
    const descriptor = (LOCALES as Record<string, LocaleDescriptor | undefined>)[code];
    if (!descriptor || descriptor.translatedKeyFloor === 'all') return 'full';
    const coverage = (descriptor.translatedKeyFloor / Object.keys(en).length) * 100;
    return coverage < MIXED_ENGLISH_COVERAGE_CEILING ? 'partial' : 'full';
}

export function translateWithFallback(t: TranslateFn, key: string, fallback: string): string {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
}

export type I18nTemplateValues = Record<string, string | number | boolean | null | undefined>;


export function resolveI18nText(
    t: TranslateFn,
    key: string,
    options?: { fallback?: string; values?: I18nTemplateValues },
): string {
    const translated = t(key);
    const text = translated && translated !== key
        ? translated
        : options?.fallback ?? getEnglishI18nValue(key) ?? key;
    return options?.values ? formatI18nTemplate(text, options.values) : text;
}


export const I18N_TEMPLATE_SLOT_PATTERN = /\{\{?\s*([A-Za-z0-9_]+)\s*\}\}?/g;


export function i18nTemplateSlots(template: string): string[] {
    const names = new Set<string>();
    for (const match of template.matchAll(I18N_TEMPLATE_SLOT_PATTERN)) names.add(match[1]);
    return [...names].sort();
}

export function formatI18nTemplate(
    template: string,
    values: I18nTemplateValues,
): string {
    return template.replace(I18N_TEMPLATE_SLOT_PATTERN, (match, key: string) => (
        Object.prototype.hasOwnProperty.call(values, key)
            ? String(values[key] ?? '')
            : match
    ));
}

export const tFallback = translateWithFallback;
