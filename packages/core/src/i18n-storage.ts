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
