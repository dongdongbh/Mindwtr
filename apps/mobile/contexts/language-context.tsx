import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { type Language, loadTranslations, loadStoredLanguage, saveStoredLanguage } from '@mindwtr/core';

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
        loadLanguage();
        loadTranslations('en').then(setFallbackTranslations).catch(() => setFallbackTranslations({}));
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
        }).catch(() => {
            if (active) setTranslationsMap({});
        });
        return () => {
            active = false;
        };
    }, [language]);

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
