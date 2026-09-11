import React, { createContext, useContext, useState, useEffect } from 'react';

import { type Language, getSystemDefaultLanguage, getTranslationsSync, loadTranslations, loadStoredLanguageSync, saveStoredLanguageSync } from '@mindwtr/core';
export type { Language };

interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (key: string) => string;
}



const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

/**
 * The UI language outside React — for code that runs in an event handler or
 * a plain module, not during render, so it can't call the useLanguage hook
 * (undo-registry.ts's toast label, mirroring App.tsx's `settingsLanguage ||
 * language` precedence). Same source LanguageProvider's own state reads on
 * mount, without the test short-circuit that exists there only to keep
 * component renders deterministic — this is a one-shot read, not state.
 */
export function getCurrentUiLanguage(): Language {
    if (typeof localStorage === 'undefined') return 'en';
    return loadStoredLanguageSync(localStorage, getSystemDefaultLanguage());
}

export function LanguageProvider({
    children,
    initialLanguage,
    persistLanguage = true,
}: {
    children: React.ReactNode;
    initialLanguage?: Language;
    persistLanguage?: boolean;
}) {
    const isTest = import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test';
    const [language, setLanguageState] = useState<Language>(() => {
        if (isTest) return 'en';
        return initialLanguage ?? getCurrentUiLanguage();
    });
    const [translationsMap, setTranslationsMap] = useState<Record<string, string>>({});
    const [fallbackTranslations, setFallbackTranslations] = useState<Record<string, string>>(() => getTranslationsSync('en'));

    useEffect(() => {
        if (isTest) return;
        setLanguageState(initialLanguage ?? getCurrentUiLanguage());
        if (!fallbackTranslations['app.name']) {
            loadTranslations('en').then(setFallbackTranslations).catch(() => setFallbackTranslations({}));
        }
    }, [fallbackTranslations, initialLanguage, isTest]);

    useEffect(() => {
        if (isTest) return;
        let active = true;
        loadTranslations(language).then((map) => {
            if (active) setTranslationsMap(map);
        }).catch(() => {
            if (active) setTranslationsMap({});
        });
        return () => {
            active = false;
        };
    }, [isTest, language]);

    const setLanguage = (lang: Language) => {
        if (persistLanguage && typeof localStorage !== 'undefined') {
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
