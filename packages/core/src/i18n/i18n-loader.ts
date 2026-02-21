import type { Language } from './i18n-types';
import { autoTranslate } from './i18n-translate';

const translationsCache = new Map<Language, Record<string, string>>();
const loadPromises = new Map<Language, Promise<void>>();

const buildTranslations = (lang: Language, base: Record<string, string>, overrides: Record<string, string>) => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        result[key] = overrides[key] ?? autoTranslate(value, lang);
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
            // Fall back to dynamic import for web/desktop bundlers.
        }
    }
    return await asyncLoader();
};

const ensureEnglishLoaded = async (): Promise<Record<string, string>> => {
    const cached = translationsCache.get('en');
    if (cached) return cached;
    const mod = await loadWithFallback(
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        () => require('./locales/en') as typeof import('./locales/en'),
        () => import('./locales/en')
    );
    translationsCache.set('en', mod.en);
    return mod.en;
};

const loadOverrides = async (lang: Language): Promise<Record<string, string> | undefined> => {
    if (lang === 'es') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/es') as typeof import('./locales/es'),
            () => import('./locales/es')
        );
        return mod.esOverrides;
    }
    if (lang === 'hi') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/hi') as typeof import('./locales/hi'),
            () => import('./locales/hi')
        );
        return mod.hiOverrides;
    }
    if (lang === 'ar') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/ar') as typeof import('./locales/ar'),
            () => import('./locales/ar')
        );
        return mod.arOverrides;
    }
    if (lang === 'de') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/de') as typeof import('./locales/de'),
            () => import('./locales/de')
        );
        return mod.deOverrides;
    }
    if (lang === 'ru') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/ru') as typeof import('./locales/ru'),
            () => import('./locales/ru')
        );
        return mod.ruOverrides;
    }
    if (lang === 'ja') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/ja') as typeof import('./locales/ja'),
            () => import('./locales/ja')
        );
        return mod.jaOverrides;
    }
    if (lang === 'fr') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/fr') as typeof import('./locales/fr'),
            () => import('./locales/fr')
        );
        return mod.frOverrides;
    }
    if (lang === 'pt') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/pt') as typeof import('./locales/pt'),
            () => import('./locales/pt')
        );
        return mod.ptOverrides;
    }
    if (lang === 'ko') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/ko') as typeof import('./locales/ko'),
            () => import('./locales/ko')
        );
        return mod.koOverrides;
    }
    if (lang === 'it') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/it') as typeof import('./locales/it'),
            () => import('./locales/it')
        );
        return mod.itOverrides;
    }
    if (lang === 'tr') {
        const mod = await loadWithFallback(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            () => require('./locales/tr') as typeof import('./locales/tr'),
            () => import('./locales/tr')
        );
        return mod.trOverrides;
    }
    return undefined;
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
        if (lang === 'zh') {
            const mod = await loadWithFallback(
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                () => require('./locales/zh') as typeof import('./locales/zh'),
                () => import('./locales/zh')
            );
            translationsCache.set('zh', mod.zh);
            return;
        }

        const base = await ensureEnglishLoaded();
        const overrides = await loadOverrides(lang);
        if (overrides) {
            translationsCache.set(lang, buildTranslations(lang, base, overrides));
            return;
        }
        translationsCache.set(lang, base);
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
