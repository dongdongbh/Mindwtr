import type { Language } from './i18n-types';

export const LANGUAGE_STORAGE_KEY = 'mindwtr-language';
export const SUPPORTED_LANGUAGES: Language[] = ['en', 'zh', 'es', 'hi', 'ar', 'de', 'ru', 'ja', 'fr', 'pt', 'pl', 'ko', 'it', 'tr'];

export const isSupportedLanguage = (value: string | null | undefined): value is Language =>
    Boolean(value && SUPPORTED_LANGUAGES.includes(value as Language));
