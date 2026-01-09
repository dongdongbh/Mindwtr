import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { type Language, loadTranslations, loadStoredLanguage, saveStoredLanguage } from '@mindwtr/core';

export type { Language };

interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (key: string) => string;
    isReady: boolean;
}



const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
    const [language, setLanguageState] = useState<Language>('en');
    const [translationsMap, setTranslationsMap] = useState<Record<string, string>>({});
    const [fallbackTranslations, setFallbackTranslations] = useState<Record<string, string>>({});
    const [hasLoadedLanguage, setHasLoadedLanguage] = useState(false);
    const [hasLoadedFallback, setHasLoadedFallback] = useState(false);
    const [hasLoadedTranslations, setHasLoadedTranslations] = useState(false);
    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
        loadLanguage().finally(() => setHasLoadedLanguage(true));
        loadTranslations('en')
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
            const saved = await loadStoredLanguage(AsyncStorage);
            setLanguageState(saved);
        } catch (error) {
            console.error('Failed to load language', error);
        }
    };

    const setLanguage = async (lang: Language) => {
        try {
            await saveStoredLanguage(AsyncStorage, lang);
            setLanguageState(lang);
        } catch (error) {
            console.error('Failed to save language', error);
        }
    };

    useEffect(() => {
        let active = true;
        loadTranslations(language).then((map) => {
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
