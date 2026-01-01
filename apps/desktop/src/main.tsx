import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';

import { setStorageAdapter } from '@mindwtr/core';
import { LanguageProvider } from './contexts/language-context';
import { isTauriRuntime } from './lib/runtime';
import { webStorage } from './lib/storage-adapter-web';
import { setupGlobalErrorLogging } from './lib/app-log';

// Initialize theme immediately before React renders to prevent flash
const THEME_STORAGE_KEY = 'mindwtr-theme';
const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
const root = document.documentElement;
const nativeTheme = savedTheme === 'dark' ? 'dark' : savedTheme === 'light' ? 'light' : null;
if (savedTheme === 'dark') {
    root.classList.add('dark');
} else if (savedTheme === 'light') {
    root.classList.remove('dark');
} else {
    // System preference
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', isDark);
}
if (isTauriRuntime()) {
    import('@tauri-apps/api/app')
        .then(({ setTheme }) => setTheme(nativeTheme))
        .catch(() => undefined);
}

async function initStorage() {
    if (isTauriRuntime()) {
        const { tauriStorage } = await import('./lib/storage-adapter');
        setStorageAdapter(tauriStorage);
        return;
    }

    setStorageAdapter(webStorage);
}

async function bootstrap() {
    await initStorage();
    setupGlobalErrorLogging();

    if (!isTauriRuntime() && 'serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }

    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <LanguageProvider>
                <App />
            </LanguageProvider>
        </React.StrictMode>,
    );
}

bootstrap().catch(console.error);
