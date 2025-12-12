import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

import { setStorageAdapter } from '@mindwtr/core';
import { tauriStorage } from './lib/storage-adapter';
import { LanguageProvider } from './contexts/language-context';

// Initialize storage adapter for desktop
setStorageAdapter(tauriStorage);

// Initialize theme immediately before React renders to prevent flash
const THEME_STORAGE_KEY = 'mindwtr-theme';
const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
const root = document.documentElement;
if (savedTheme === 'dark') {
    root.classList.add('dark');
} else if (savedTheme === 'light') {
    root.classList.remove('dark');
} else {
    // System preference
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', isDark);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <LanguageProvider>
            <App />
        </LanguageProvider>
    </React.StrictMode>,
)

