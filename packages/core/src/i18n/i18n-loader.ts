import type { Language } from './i18n-types';
import { LOCALES } from './i18n-locales';
import { en } from './locales/en';

const englishTranslations = en;
const translationsCache = new Map<Language, Record<string, string>>([
    ['en', englishTranslations],
]);
const loadPromises = new Map<Language, Promise<void>>();

const buildTranslations = (base: Record<string, string>, overrides: Record<string, string>) => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        result[key] = overrides[key] ?? value;
    }
    return result;
};

const loadWithFallback = async <T>(
    syncLoader: () => T,
    asyncLoader: () => Promise<T>
): Promise<T> => {
    if (typeof require === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        try {
            return syncLoader();
        } catch {

        }
    }
    return await asyncLoader();
};

const ensureEnglishLoaded = async (): Promise<Record<string, string>> => {
    const cached = translationsCache.get('en');
    if (cached) return cached;
    translationsCache.set('en', englishTranslations);
    return englishTranslations;
};

async function ensureLoaded(lang: Language): Promise<void> {
    if (translationsCache.has(lang)) return;
    const inFlight = loadPromises.get(lang);
    if (inFlight) {
        await inFlight;
        return;
    }

    const promise = (async () => {
        if (lang === 'en') {
            await ensureEnglishLoaded();
            return;
        }

        const descriptor = LOCALES[lang];


        const loadSync = descriptor.loadSync as () => Record<string, unknown>;
        const loadAsync = descriptor.loadAsync as () => Promise<Record<string, unknown>>;
        const mod = await loadWithFallback(loadSync, loadAsync) as Record<string, Record<string, string>>;
        const loaded = mod[descriptor.export];

        if (descriptor.mode === 'full') {
            translationsCache.set(lang, loaded);
            return;
        }

        const base = await ensureEnglishLoaded();
        translationsCache.set(lang, buildTranslations(base, loaded));
    })();

    loadPromises.set(lang, promise);
    try {
        await promise;
    } catch (error) {
        loadPromises.delete(lang);
        throw error;
    }
}

export async function loadTranslations(lang: Language): Promise<Record<string, string>> {
    await ensureLoaded(lang);
    return translationsCache.get(lang) || translationsCache.get('en') || {};
}

export async function getTranslations(lang: Language): Promise<Record<string, string>> {
    return loadTranslations(lang);
}

export function getTranslationsSync(lang: Language): Record<string, string> {
    return translationsCache.get(lang) || translationsCache.get('en') || {};
}
