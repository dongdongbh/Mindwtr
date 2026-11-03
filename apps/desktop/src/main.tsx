

import { workspaceStorageScopeFailed } from './lib/workspace-storage-scope';
import React from 'react';
import { markDesktopStartup } from './lib/startup-profiler';
import ReactDOM from 'react-dom/client';
import './index.css';

import {
    consoleLogger,
    createSandboxData,
    createSandboxStorage,
    getPersistenceStatus,
    initializeSandboxRuntime,
    setLogger,
    setStorageAdapter,
    type Language,
} from '@mindwtr/core';
import { LanguageProvider } from './contexts/language-context';
import { isTauriRuntime } from './lib/runtime';
import { invokeNative, preloadNativeTransport } from './lib/tauri-invoke';
import { reportError } from './lib/report-error';
import { webStorage } from './lib/storage-adapter-web';
import { isDiagnosticsEnabled, logError, logInfo, logWarn, setupGlobalErrorLogging } from './lib/app-log';
import { registerWebServiceWorker } from './lib/web-service-worker';
import {
    THEME_STORAGE_KEY,
    applyNativeTheme,
    applyStartupSystemThemeBeforeApp,
    applySystemThemeChange,
    applyThemeMode,
    coerceDesktopThemeMode,
    resolveNativeTheme,
    resolveSystemThemeCommandPreference,
} from './lib/theme';
import { TEXT_SIZE_STORAGE_KEY, applyDesktopTextSize, coerceDesktopTextSize } from './lib/text-size';
import { FONT_FAMILY_STORAGE_KEY, applyDesktopFontFamily, coerceDesktopFontFamily } from './lib/font-family';
import { loadStoredFullscreen } from './lib/window-state';
import { restoreStoredWebviewZoom } from './lib/webview-zoom';
import { isQuickAddWindowLocation } from './lib/quick-add-window';
import {
    sendDesktopDailyHeartbeat,
} from './lib/analytics-heartbeat';
import { consumeDesktopSandboxBootRequest } from './lib/sandbox-session';
import { installAppLockKeyboardGuard, loadAppLockState } from './lib/app-lock';
import { AppLockGate } from './components/AppLockGate';

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
                force: payload.force,
            });
            return;
        }
        if (payload.level === 'warn') {
            void logWarn(payload.message, { scope, extra, force: payload.force });
            return;
        }
        void logInfo(payload.message, { scope, extra, force: payload.force });
    });
};

installCoreLoggerBridge();
const isQuickAddWindow = isQuickAddWindowLocation();
if (isQuickAddWindow) {
    document.documentElement.dataset.quickAddWindow = 'true';
}

async function initStorage() {
    if (isTauriRuntime()) {
        const { tauriStorage, getDesktopSaveStatus } = await import('./lib/storage-adapter');
        setStorageAdapter(tauriStorage);

        if (import.meta.env.VITE_STARTUP_PROFILING === '1') {
            Object.defineProperty(window, '__mindwtrSaveStatus', {
                value: () => ({ core: getPersistenceStatus(), desktop: getDesktopSaveStatus() }),
                configurable: true,
            });
        }
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

async function restoreWebviewZoomState() {
    if (!isTauriRuntime()) return;
    try {
        await restoreStoredWebviewZoom({ storage: localStorage });
    } catch (error) {
        void logWarn('Failed to restore webview zoom', {
            scope: 'window',
            extra: {
                step: 'restoreWebviewZoom',
                error: error instanceof Error ? error.message : String(error),
            },
        });
    }
}


function installFileDropNavigationGuard() {
    const isFileDrag = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'));
    document.addEventListener('dragover', (event) => {
        if (isFileDrag(event)) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
        if (isFileDrag(event)) event.preventDefault();
    });
}


async function signalUiReady() {
    if (!isTauriRuntime()) return;
    try {


        await preloadNativeTransport();
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        await invokeNative('notify_ui_ready');
    } catch (error) {
        void logWarn('Failed to signal UI ready', {
            scope: 'window',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
}

async function bootstrap() {
    markDesktopStartup('bootstrap');
    if (!isQuickAddWindow) installAppLockKeyboardGuard();
    installFileDropNavigationGuard();


    const sandboxSettings = isQuickAddWindow ? null : consumeDesktopSandboxBootRequest();
    const sandboxMode = sandboxSettings !== null;
    initializeSandboxRuntime(sandboxMode);
    if (sandboxMode) {
        setStorageAdapter(createSandboxStorage(createSandboxData({ settings: sandboxSettings })));
        void logInfo('Sandbox workspace bootstrap complete', {
            scope: 'sandbox',
            force: true,
            extra: {
                releaseCheck: 'v1.3.0/sandbox-workspace',
                workspace: 'sandbox',
            },
        });
    } else {
        await initStorage();
    }
    markDesktopStartup('storage_adapter_ready');


    const initialTheme = coerceDesktopThemeMode(
        sandboxMode ? sandboxSettings.theme : localStorage.getItem(THEME_STORAGE_KEY),
    );
    applyThemeMode(initialTheme);
    let appOwnsTheme = false;
    if (((initialTheme ?? 'system') === 'system' || initialTheme === 'system-oled') && isTauriRuntime()) {
        void applyStartupSystemThemeBeforeApp(
            resolveSystemThemeCommandPreference(
                (step, error) => void logError(error, { scope: 'theme', step: `startup-command:${step}` }),
            ),
            () => appOwnsTheme,
            (theme) => applySystemThemeChange(initialTheme, theme, () => {
                void applyNativeTheme(
                    resolveNativeTheme(initialTheme, theme),
                    () => import('@tauri-apps/api/app'),
                    () => import('@tauri-apps/api/window'),
                );
            }),
        );
    }
    applyDesktopTextSize(coerceDesktopTextSize(
        sandboxMode ? sandboxSettings.appearance?.textSize : localStorage.getItem(TEXT_SIZE_STORAGE_KEY),
    ));
    applyDesktopFontFamily(coerceDesktopFontFamily(
        sandboxMode ? sandboxSettings.appearance?.fontFamily : localStorage.getItem(FONT_FAMILY_STORAGE_KEY),
    ));
    if (isTauriRuntime()) {
        void applyNativeTheme(
            resolveNativeTheme(initialTheme),
            () => import('@tauri-apps/api/app'),
            () => import('@tauri-apps/api/window'),
        );
    }

    if (!sandboxMode && isDiagnosticsEnabled()) setupGlobalErrorLogging();
    if (workspaceStorageScopeFailed) {

        void logWarn('Workspace storage scope unavailable', {
            scope: 'app',
            force: true,
            extra: { releaseCheck: 'v1.3.8/desktop-workspaces', outcome: 'storage-unscoped' },
        });
    }
    if (!isQuickAddWindow && !sandboxMode) {
        await restoreFullscreenState();
        await restoreWebviewZoomState();
    }


    if (!import.meta.env.DEV && !isQuickAddWindow && !isTauriRuntime() && 'serviceWorker' in navigator) {
        registerWebServiceWorker(() => {
            void logInfo('Online-only service worker controls this page', {
                scope: 'pwa', force: true,
                extra: { releaseCheck: 'v1.3.8/web-online-only' },
            });
        });
    }

    if (!isTauriRuntime()) {


        window.addEventListener('vite:preloadError', () => {
            const RELOAD_FLAG = 'mindwtr-chunk-reload-at';
            const lastReload = Number(sessionStorage.getItem(RELOAD_FLAG) || 0);
            if (Date.now() - lastReload < 30_000) return;
            sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
            window.location.reload();
        });
    }


    if (!isQuickAddWindow) await loadAppLockState();
    const RootApp = isQuickAddWindow
        ? (await import('./QuickAddWindowApp.tsx')).QuickAddWindowApp
        : (await import('./App.tsx')).default;

    const initialLanguage = sandboxSettings?.language && sandboxSettings.language !== 'system'
        ? sandboxSettings.language as Language
        : undefined;
    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <LanguageProvider initialLanguage={initialLanguage} persistLanguage={!sandboxMode}>
                <RootApp />
                {!isQuickAddWindow && <AppLockGate />}
            </LanguageProvider>
        </React.StrictMode>,
    );

    appOwnsTheme = !isQuickAddWindow;

    if (!isQuickAddWindow) {
        requestAnimationFrame(() => markDesktopStartup('shell_ready'));
        void signalUiReady();
        if (!sandboxMode) void sendDesktopDailyHeartbeat().catch((error) => {
            void logWarn('Desktop analytics heartbeat failed', {
                scope: 'analytics',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        });
    }
}

bootstrap().catch((error) => reportError('Failed to start app', error));
