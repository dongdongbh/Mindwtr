import React, { createContext, useContext, useState, useEffect } from 'react';

import { type Language, loadTranslations, loadStoredLanguageSync, saveStoredLanguageSync } from '@mindwtr/core';
export type { Language };

interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (key: string) => string;
}



const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
    const [language, setLanguageState] = useState<Language>('en');
    const [translationsMap, setTranslationsMap] = useState<Record<string, string>>({});
    const [fallbackTranslations, setFallbackTranslations] = useState<Record<string, string>>({});

    useEffect(() => {
        if (typeof localStorage !== 'undefined') {
            setLanguageState(loadStoredLanguageSync(localStorage));
        }
        loadTranslations('en').then(setFallbackTranslations).catch(() => setFallbackTranslations({}));
    }, []);

    useEffect(() => {
        let active = true;
        loadTranslations(language).then((map) => {
            if (active) setTranslationsMap(map);
        }).catch(() => {
            if (active) setTranslationsMap({});
        });
        return () => {
            active = false;
        };
    }, [language]);

    const setLanguage = (lang: Language) => {
        if (typeof localStorage !== 'undefined') {
            saveStoredLanguageSync(localStorage, lang);
        }
        setLanguageState(lang);
    };

    const t = (key: string): string => {
        return translationsMap[key] || fallbackTranslations[key] || key;
    };

    return (
        <LanguageContext.Provider value={{ language, setLanguage, t }}>
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
