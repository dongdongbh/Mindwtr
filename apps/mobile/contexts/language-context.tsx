import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { type Language, getSystemDefaultLanguage, loadTranslations, loadStoredLanguage, saveStoredLanguage } from '@mindwtr/core';
import { logError } from '../lib/app-log';
import { markStartupPhase, measureStartupPhase } from '../lib/startup-profiler';

export type { Language };

interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (key: string) => string;
    isReady: boolean;
}



const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
    const [language, setLanguageState] = useState<Language>(() => getSystemDefaultLanguage());
    const [translationsMap, setTranslationsMap] = useState<Record<string, string>>({});
    const [fallbackTranslations, setFallbackTranslations] = useState<Record<string, string>>({});
    const [hasLoadedLanguage, setHasLoadedLanguage] = useState(false);
    const [hasLoadedFallback, setHasLoadedFallback] = useState(false);
    const [hasLoadedTranslations, setHasLoadedTranslations] = useState(false);
    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
        markStartupPhase('js.language.load:start');
        loadLanguage().finally(() => setHasLoadedLanguage(true));
        measureStartupPhase('js.language.load_fallback_en', async () => loadTranslations('en'))
            .then((map) => {
                setFallbackTranslations(map);
                setHasLoadedFallback(true);
            })
            .catch(() => {
                setFallbackTranslations({});
                setHasLoadedFallback(true);
            });
    }, []);

    const loadLanguage = async () => {
        try {
            const saved = await measureStartupPhase('js.language.load_stored_language', async () =>
                loadStoredLanguage(AsyncStorage, getSystemDefaultLanguage())
            );
            setLanguageState(saved);
        } catch (error) {
            void logError(error, { scope: 'i18n', extra: { message: 'Failed to load language' } });
        }
    };

    const setLanguage = async (lang: Language) => {
        try {
            await saveStoredLanguage(AsyncStorage, lang);
            setLanguageState(lang);
        } catch (error) {
            void logError(error, { scope: 'i18n', extra: { message: 'Failed to save language' } });
        }
    };

    useEffect(() => {
        let active = true;
        void measureStartupPhase('js.language.load_active_translations', async () => loadTranslations(language)).then((map) => {
            if (active) setTranslationsMap(map);
            if (active) setHasLoadedTranslations(true);
        }).catch(() => {
            if (active) setTranslationsMap({});
            if (active) setHasLoadedTranslations(true);
        });
        return () => {
            active = false;
        };
    }, [language]);

    useEffect(() => {
        if (!isReady && hasLoadedLanguage && hasLoadedFallback && hasLoadedTranslations) {
            setIsReady(true);
            markStartupPhase('js.language.load:end');
        }
    }, [hasLoadedFallback, hasLoadedLanguage, hasLoadedTranslations, isReady]);

    const t = (key: string): string => {
        return translationsMap[key] || fallbackTranslations[key] || key;
    };

    return (
        <LanguageContext.Provider value={{ language, setLanguage, t, isReady }}>
            {children}
        </LanguageContext.Provider>
    );
}

export function useLanguage() {
    const context = useContext(LanguageContext);
    if (!context) {
        throw new Error('useLanguage must be used within a LanguageProvider');
    }
    return context;
}
