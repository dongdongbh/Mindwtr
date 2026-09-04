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

/**
 * A TranslateFn for one language, with the English dictionary behind it. Non-React callers
 * (notification schedulers, sync, stores) used to hand-roll this and read `dict[key]` raw,
 * which returns undefined for any key an override dictionary correctly omits.
 *
 * Returning the key on a miss is what makes this composable: resolveI18nText already treats
 * "value === key" as the miss signal, so the miss policy stays in one place.
 */
export function getTranslator(language: string): TranslateFn {
    const translations = isSupportedLanguage(language) ? getTranslationsSync(language) : {};
    return (key: string) => translations[key] ?? en[key] ?? key;
}

export function getEnglishI18nValue(key: string): string | undefined {
    return en[key];
}

/**
 * Whether a language is complete enough to present without a caveat. Derived from the
 * locale's `translatedKeyFloor` (the ratcheted commitment, so this self-updates as
 * translation work lands) over the English key count — no hand-maintained per-locale data.
 *
 * Reuses MIXED_ENGLISH_COVERAGE_CEILING rather than minting a second ~90 constant: that
 * number already encodes "at or above this the locale is essentially complete and the
 * English left in it is deliberate", which is the same judgement a user-facing
 * "partly translated" caveat needs. 'all' is full by definition.
 *
 * Lives here, not in i18n-locales.ts, because that table deliberately imports no dictionary.
 */
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

// The one home for "resolve a display string". `t()` returns the KEY on a miss
// on both platforms, so a miss is `t(key) === key` (or empty) -- what to show
// instead is a policy, and it used to be hand-written in five app-level shapes
// where no core test could reach it. One of those shapes machine-translated the
// English word by word and shipped word salad for two years.
//
// Miss order: an explicit `fallback` (the caller knows better than the locale
// table), else the English copy, else the raw key so the miss is visible.
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

/**
 * What counts as an interpolation slot. Both brace styles are live: en.ts uses
 * `{{count}}` for most keys and bare `{count}` for others (calendar.searchMatches,
 * task.markedDone, the recurrence descriptions), and this pattern has always
 * accepted either.
 *
 * Exported so the parity guard measures slots with the exact expression that fills
 * them. A locale that drops a slot renders a sentence with the number or name
 * silently missing — "matches in this view" with no count — which no other check
 * sees, because the value is otherwise a perfectly good translation.
 */
export const I18N_TEMPLATE_SLOT_PATTERN = /\{\{?\s*([A-Za-z0-9_]+)\s*\}\}?/g;

/** The set of slot names in `template`, sorted, for comparing a translation to its English source. */
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
