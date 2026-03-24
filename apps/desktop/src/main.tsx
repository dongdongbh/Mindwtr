import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';

import { generateUUID, sendDailyHeartbeat, setStorageAdapter } from '@mindwtr/core';
import { LanguageProvider } from './contexts/language-context';
import { getInstallSourceOrFallback, isTauriRuntime } from './lib/runtime';
import { normalizeAnalyticsInstallChannel } from './lib/install-source';
import { reportError } from './lib/report-error';
import { webStorage } from './lib/storage-adapter-web';
import { logWarn, setupGlobalErrorLogging } from './lib/app-log';
import { THEME_STORAGE_KEY, applyThemeMode, coerceDesktopThemeMode, resolveNativeTheme } from './lib/theme';

const ANALYTICS_DISTINCT_ID_KEY = 'mindwtr-analytics-distinct-id';
const ANALYTICS_HEARTBEAT_URL = String(import.meta.env.VITE_ANALYTICS_HEARTBEAT_URL || '').trim();

const parseBool = (value: string | undefined): boolean => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const heartbeatDisabled = parseBool(import.meta.env.VITE_DISABLE_HEARTBEAT);

const detectDesktopPlatform = (): string => {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) return 'windows';
    if (userAgent.includes('mac')) return 'macos';
    if (userAgent.includes('linux')) return 'linux';
    return 'unknown';
};

const getDesktopLocale = (): string => {
    const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
    const locale = String(candidates?.[0] || '').trim();
    return locale;
};

const getDesktopOsMajor = (platform: string): string => {
    const userAgent = navigator.userAgent;
    if (platform === 'windows') {
        const match = userAgent.match(/windows nt\s+(\d+)/i);
        if (match?.[1]) return `windows-${match[1]}`;
        return 'windows';
    }
    if (platform === 'macos') {
        const match = userAgent.match(/mac os x\s+(\d+)/i);
        if (match?.[1]) return `macos-${match[1]}`;
        return 'macos';
    }
    if (platform === 'linux') {
        return 'linux';
    }
    return 'unknown';
};

const getOrCreateAnalyticsDistinctId = (): string => {
    const existing = localStorage.getItem(ANALYTICS_DISTINCT_ID_KEY)?.trim();
    if (existing) return existing;
    const generated = generateUUID();
    localStorage.setItem(ANALYTICS_DISTINCT_ID_KEY, generated);
    return generated;
};

const getDesktopChannel = async (): Promise<string> => {
    if (!isTauriRuntime()) return 'web';
    try {
        const source = await getInstallSourceOrFallback('unknown');
        return normalizeAnalyticsInstallChannel(source);
    } catch {
        return 'unknown';
    }
};

const getDesktopVersion = async (): Promise<string> => {
    if (!isTauriRuntime()) return 'web';
    try {
        const { getVersion } = await import('@tauri-apps/api/app');
        return await getVersion();
    } catch {
        return '0.0.0';
    }
};

const sendDesktopHeartbeat = async (): Promise<void> => {
    if (!isTauriRuntime()) return;
    if (import.meta.env.DEV || import.meta.env.VITEST || import.meta.env.MODE === 'test' || process.env.NODE_ENV === 'test') return;
    if (heartbeatDisabled || !ANALYTICS_HEARTBEAT_URL) return;
    try {
        const [channel, appVersion] = await Promise.all([
            getDesktopChannel(),
            getDesktopVersion(),
        ]);
        const platform = detectDesktopPlatform();
        const distinctId = getOrCreateAnalyticsDistinctId();
        await sendDailyHeartbeat({
            enabled: true,
            endpointUrl: ANALYTICS_HEARTBEAT_URL,
            distinctId,
            platform,
            channel,
            appVersion,
            deviceClass: 'desktop',
            osMajor: getDesktopOsMajor(platform),
            locale: getDesktopLocale(),
            storage: localStorage,
        });
    } catch (error) {
        void logWarn('Desktop analytics heartbeat failed', {
            scope: 'analytics',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
};

// Initialize theme immediately before React renders to prevent flash
const savedTheme = coerceDesktopThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
applyThemeMode(savedTheme);

const diagnosticsEnabled = typeof window !== 'undefined'
    && (window as any).__MINDWTR_DIAGNOSTICS__ === true;
if (diagnosticsEnabled) {
    setupGlobalErrorLogging();
}

const nativeTheme = resolveNativeTheme(savedTheme);
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

    void sendDesktopHeartbeat();
}

bootstrap().catch((error) => reportError('Failed to start app', error));
