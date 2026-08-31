import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { QuickAddWindowApp } from './QuickAddWindowApp.tsx';
import './index.css';

import { consoleLogger, setLogger, setStorageAdapter } from '@mindwtr/core';
import { LanguageProvider } from './contexts/language-context';
import { isTauriRuntime } from './lib/runtime';
import { invokeNative, preloadNativeTransport } from './lib/tauri-invoke';
import { reportError } from './lib/report-error';
import { webStorage } from './lib/storage-adapter-web';
import { isDiagnosticsEnabled, logError, logInfo, logWarn, setupGlobalErrorLogging } from './lib/app-log';
import {
    THEME_STORAGE_KEY,
    applyNativeTheme,
    applyThemeMode,
    coerceDesktopThemeMode,
    resolveNativeTheme,
    resolveSystemThemeCommandPreference,
} from './lib/theme';
import { TEXT_SIZE_STORAGE_KEY, applyDesktopTextSize, coerceDesktopTextSize } from './lib/text-size';
import { loadStoredFullscreen } from './lib/window-state';
import { restoreStoredWebviewZoom } from './lib/webview-zoom';
import { isQuickAddWindowLocation } from './lib/quick-add-window';
import { isDesktopWidgetLocation } from './components/widgets/widget-data';
import { DesktopWidgetApp } from './components/widgets/DesktopWidgetApp';
import {
    sendDesktopDailyHeartbeat,
} from './lib/analytics-heartbeat';

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

// Initialize theme immediately before React renders to prevent flash
const savedTheme = coerceDesktopThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
applyThemeMode(savedTheme);
if ((savedTheme ?? 'system') === 'system' && isTauriRuntime()) {
    void resolveSystemThemeCommandPreference(
        (step, error) => void logError(error, { scope: 'theme', step: `startup-command:${step}` }),
    ).then((theme) => {
        if (theme) applyThemeMode('system', theme);
    });
}
const savedTextSize = coerceDesktopTextSize(localStorage.getItem(TEXT_SIZE_STORAGE_KEY));
applyDesktopTextSize(savedTextSize);

installCoreLoggerBridge();

const diagnosticsEnabled = isDiagnosticsEnabled();
if (diagnosticsEnabled) {
    setupGlobalErrorLogging();
}
const isQuickAddWindow = isQuickAddWindowLocation();
if (isQuickAddWindow) {
    document.documentElement.dataset.quickAddWindow = 'true';
}
const isDesktopWidgetWindow = isDesktopWidgetLocation();
if (isDesktopWidgetWindow) {
    document.documentElement.dataset.desktopWidgetWindow = 'true';
}

const nativeTheme = resolveNativeTheme(savedTheme);
if (isTauriRuntime()) {
    void applyNativeTheme(
        nativeTheme,
        () => import('@tauri-apps/api/app'),
        () => import('@tauri-apps/api/window'),
    );
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

// Tauri's native drag-drop handler is off (tauri.conf.json dragDropEnabled:
// false) so HTML5 drag-and-drop works for task rows; that also means the
// webview's plain browser default runs for OS file drops anywhere else,
// navigating away to the dropped file. Block navigation here, but only
// preventDefault (never stopPropagation) so the editor's own file-drop
// handler, which runs first since React attaches below document, still
// gets the event.
function installFileDropNavigationGuard() {
    const isFileDrag = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'));
    document.addEventListener('dragover', (event) => {
        if (isFileDrag(event)) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
        if (isFileDrag(event)) event.preventDefault();
    });
}

// The main window is built hidden so the restored geometry and the first paint
// stay off screen (#936). Two animation frames after the first render is the
// cheapest "has painted" signal the webview gives us; Rust reveals the window
// anyway after a few seconds if this never arrives.
async function signalUiReady() {
    if (!isTauriRuntime()) return;
    try {
        // Resolve the transport during the paint wait, not on the reveal call
        // itself — the two frames below are the signal's timing, and nothing
        // else may be added to it.
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
    installFileDropNavigationGuard();
    await initStorage();
    setupGlobalErrorLogging();
    if (!isQuickAddWindow && !isDesktopWidgetWindow) {
        await restoreFullscreenState();
        await restoreWebviewZoomState();
    }

    if (!isQuickAddWindow && !isDesktopWidgetWindow && !isTauriRuntime() && 'serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }

    if (!isTauriRuntime()) {
        // A lazy route chunk can fail to import when the served index.html and
        // the deployed assets are from different builds (web app redeployed
        // while a tab was open, or a stale cached shell). One reload fetches a
        // fresh shell with matching chunk names; the guard stops a reload loop
        // when the failure is not staleness.
        window.addEventListener('vite:preloadError', () => {
            const RELOAD_FLAG = 'mindwtr-chunk-reload-at';
            const lastReload = Number(sessionStorage.getItem(RELOAD_FLAG) || 0);
            if (Date.now() - lastReload < 30_000) return;
            sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
            window.location.reload();
        });
    }

    const RootApp = isQuickAddWindow ? QuickAddWindowApp : isDesktopWidgetWindow ? DesktopWidgetApp : App;

    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <LanguageProvider>
                <RootApp />
            </LanguageProvider>
        </React.StrictMode>,
    );

    if (!isQuickAddWindow && !isDesktopWidgetWindow) {
        void signalUiReady();
        void sendDesktopDailyHeartbeat().catch((error) => {
            void logWarn('Desktop analytics heartbeat failed', {
                scope: 'analytics',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        });
    }
}

bootstrap().catch((error) => reportError('Failed to start app', error));
