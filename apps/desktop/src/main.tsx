import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';

import { type AppData, consoleLogger, generateUUID, sendDailyHeartbeat, setLogger, setStorageAdapter, SQLITE_SCHEMA_VERSION } from '@mindwtr/core';
import { LanguageProvider } from './contexts/language-context';
import { getInstallSourceOrFallback, isTauriRuntime } from './lib/runtime';
import { normalizeAnalyticsInstallChannel } from './lib/install-source';
import { reportError } from './lib/report-error';
import { webStorage } from './lib/storage-adapter-web';
import { isDiagnosticsEnabled, logError, logInfo, logWarn, setupGlobalErrorLogging } from './lib/app-log';
import { THEME_STORAGE_KEY, applyThemeMode, coerceDesktopThemeMode, resolveNativeTheme } from './lib/theme';
import { TEXT_SIZE_STORAGE_KEY, applyDesktopTextSize, coerceDesktopTextSize } from './lib/text-size';
import { loadStoredFullscreen } from './lib/window-state';

const ANALYTICS_DISTINCT_ID_KEY = 'mindwtr-analytics-distinct-id';
const ANALYTICS_HEARTBEAT_URL = String(import.meta.env.VITE_ANALYTICS_HEARTBEAT_URL || '').trim();

const parseBool = (value: string | undefined): boolean => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const heartbeatDisabled = parseBool(import.meta.env.VITE_DISABLE_HEARTBEAT);
let coreLoggerBridgeInstalled = false;

const buildCoreLogExtra = (payload: {
    category?: string;
    context?: Record<string, unknown>;
    error?: unknown;
}): Record<string, unknown> | undefined => {
    const extra: Record<string, unknown> = {
        ...(payload.context ?? {}),
    };
    if (payload.category) {
        extra.category = payload.category;
    }
    if (payload.error) {
        extra.error = payload.error instanceof Error ? payload.error.message : String(payload.error);
        if (payload.error instanceof Error && payload.error.name) {
            extra.errorName = payload.error.name;
        }
        if (payload.error instanceof Error && payload.error.stack) {
            extra.errorStack = payload.error.stack;
        }
    }
    return Object.keys(extra).length > 0 ? extra : undefined;
};

const installCoreLoggerBridge = () => {
    if (coreLoggerBridgeInstalled) return;
    coreLoggerBridgeInstalled = true;
    setLogger((payload) => {
        consoleLogger(payload);
        const scope = payload.scope ?? 'core';
        const extra = buildCoreLogExtra(payload);
        if (payload.level === 'error') {
            void logError(payload.error ?? payload.message, {
                scope,
                extra,
                message: payload.message,
            });
            return;
        }
        if (payload.level === 'warn') {
            void logWarn(payload.message, { scope, extra });
            return;
        }
        void logInfo(payload.message, { scope, extra });
    });
};

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

const getLoggingReason = (loggingEnabled: boolean): string => {
    if (isDiagnosticsEnabled()) return 'diagnostics-build';
    return loggingEnabled ? 'user-enabled' : 'startup-force';
};

const getStartupLoggingEnabled = async (): Promise<boolean> => {
    if (isTauriRuntime()) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const data = await invoke<AppData>('get_data');
            return data?.settings?.diagnostics?.loggingEnabled === true;
        } catch {
            return false;
        }
    }
    try {
        const data = await webStorage.getData();
        return data.settings.diagnostics?.loggingEnabled === true;
    } catch {
        return false;
    }
};

const logDesktopStartupContext = async (): Promise<void> => {
    const platform = detectDesktopPlatform();
    const [channel, version, loggingEnabled, syncBackend] = await Promise.all([
        getDesktopChannel(),
        getDesktopVersion(),
        getStartupLoggingEnabled(),
        isTauriRuntime()
            ? import('./lib/sync-service')
                .then(({ SyncService }) => SyncService.getSyncBackend())
                .catch(() => 'off')
            : Promise.resolve('off'),
    ]);

    void logInfo('App started', {
        scope: 'startup',
        force: true,
        extra: {
            version,
            platform,
            osMajor: getDesktopOsMajor(platform),
            locale: getDesktopLocale(),
            channel,
            syncBackend,
            schemaVersion: String(SQLITE_SCHEMA_VERSION),
            loggingReason: getLoggingReason(loggingEnabled),
        },
    });
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
const savedTextSize = coerceDesktopTextSize(localStorage.getItem(TEXT_SIZE_STORAGE_KEY));
applyDesktopTextSize(savedTextSize);

installCoreLoggerBridge();

const diagnosticsEnabled = isDiagnosticsEnabled();
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

async function restoreFullscreenState() {
    if (!isTauriRuntime()) return;
    if (!loadStoredFullscreen(localStorage)) return;
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const current = getCurrentWindow();
        if (await current.isFullscreen()) return;
        await current.setFullscreen(true);
    } catch (error) {
        void logWarn('Failed to restore fullscreen state', {
            scope: 'window',
            extra: {
                step: 'restoreFullscreen',
                error: error instanceof Error ? error.message : String(error),
            },
        });
    }
}

async function bootstrap() {
    await initStorage();
    setupGlobalErrorLogging();
    await logDesktopStartupContext().catch(() => undefined);
    await restoreFullscreenState();

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
