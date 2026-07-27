import type { Language } from './i18n-types';
import { isSupportedLanguage, LANGUAGE_STORAGE_KEY } from './i18n-constants';

type KeyValueStorageSync = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
};

type KeyValueStorageAsync = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
};

const WELL_SUPPORTED_DEFAULT_LANGUAGES = new Set<Language>(['en', 'zh', 'zh-Hant', 'es', 'ko']);

/**
 * Resolve app language from a locale string.
 * Only auto-selects languages we consider well-supported; otherwise falls back to English.
 */
export function resolveLanguageFromLocale(locale: string | null | undefined, fallback: Language = 'en'): Language {
    if (!locale) return fallback;
    const normalized = locale.trim().replace(/_/g, '-');
    const lower = normalized.toLowerCase();
    const primary = lower.split('-')[0];
    if (!primary) return fallback;
    if (primary === 'zh') {
        if (lower.includes('-hant') || /-(tw|hk|mo)\b/.test(lower)) return 'zh-Hant';
        return 'zh';
    }
    if (!isSupportedLanguage(primary)) return fallback;
    return WELL_SUPPORTED_DEFAULT_LANGUAGES.has(primary) ? primary : fallback;
}

function detectSystemLocale(): string | null {
    const isTestRuntime = typeof process !== 'undefined'
        && typeof process.env === 'object'
        && (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true');
    if (isTestRuntime) return null;

    if (typeof navigator !== 'undefined') {
        if (Array.isArray(navigator.languages) && typeof navigator.languages[0] === 'string' && navigator.languages[0]) {
            return navigator.languages[0];
        }
        if (typeof navigator.language === 'string' && navigator.language) {
            return navigator.language;
        }
    }
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
        try {
            return Intl.DateTimeFormat().resolvedOptions().locale || null;
        } catch {
            return null;
        }
    }
    return null;
}

export function getSystemDefaultLanguage(fallback: Language = 'en'): Language {
    return resolveLanguageFromLocale(detectSystemLocale(), fallback);
}

export function loadStoredLanguageSync(storage: KeyValueStorageSync, fallback: Language = 'en'): Language {
    const saved = storage.getItem(LANGUAGE_STORAGE_KEY);
    return isSupportedLanguage(saved) ? saved : fallback;
}

export function saveStoredLanguageSync(storage: KeyValueStorageSync, lang: Language): void {
    storage.setItem(LANGUAGE_STORAGE_KEY, lang);
}

export async function loadStoredLanguage(storage: KeyValueStorageAsync, fallback: Language = 'en'): Promise<Language> {
    const saved = await storage.getItem(LANGUAGE_STORAGE_KEY);
    return isSupportedLanguage(saved) ? saved : fallback;
}

export async function saveStoredLanguage(storage: KeyValueStorageAsync, lang: Language): Promise<void> {
    await storage.setItem(LANGUAGE_STORAGE_KEY, lang);
}
