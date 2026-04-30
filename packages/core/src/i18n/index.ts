export type { Language } from './i18n-types';
export { translateText } from './i18n-translate';

export type TranslateFn = (key: string) => string;

export function translateWithFallback(t: TranslateFn, key: string, fallback: string): string {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
}

export const tFallback = translateWithFallback;
