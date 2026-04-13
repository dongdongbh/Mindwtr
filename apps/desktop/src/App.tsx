import { useEffect, useState, useRef, useTransition, useCallback, Suspense, lazy } from 'react';
import { Layout } from './components/Layout';
import { ListView } from './components/views/ListView';
import { CalendarView } from './components/views/CalendarView';
const BoardView = lazy(() => import('./components/views/BoardView').then((m) => ({ default: m.BoardView })));
const ObsidianView = lazy(() => import('./components/views/ObsidianView').then((m) => ({ default: m.ObsidianView })));
import { ContextsView } from './components/views/ContextsView';
import { ProjectsView as ProjectsViewEager } from './components/views/ProjectsView';
const ReviewView = lazy(() => import('./components/views/ReviewView').then((m) => ({ default: m.ReviewView })));
import { ArchiveView } from './components/views/ArchiveView';
import { TrashView } from './components/views/TrashView';
import { AgendaView } from './components/views/AgendaView';
import { SearchView } from './components/views/SearchView';
import { addBreadcrumb, useTaskStore, configureDateFormatting, flushPendingSave, isSupportedLanguage } from '@mindwtr/core';
import { GlobalSearch } from './components/GlobalSearch';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useLanguage } from './contexts/language-context';
import { KeybindingProvider } from './contexts/keybinding-context';
import { QuickAddModal } from './components/QuickAddModal';
import { CloseBehaviorModal } from './components/CloseBehaviorModal';
import { startDesktopNotifications, stopDesktopNotifications } from './lib/notification-service';
import { SyncService } from './lib/sync-service';
import type { ExternalSyncChange, ExternalSyncChangeResolution } from './lib/sync-service';
import * as LocalDataWatcher from './lib/local-data-watcher';
import { isFlatpakRuntime, isTauriRuntime } from './lib/runtime';
import { logError } from './lib/app-log';
import { createDesktopAutoSyncController } from './lib/auto-sync-controller';
import { canDesktopAutoSync } from './lib/desktop-auto-sync-eligibility';
import { beginSettingsOpenTrace, markSettingsOpenTrace, wrapSettingsOpenImport } from './lib/settings-open-diagnostics';
import {
    THEME_STORAGE_KEY,
    applyThemeMode,
    mapSyncedThemeToDesktop,
    resolveNativeTheme,
    watchNativeSystemThemePreference,
    watchSystemThemePreference,
} from './lib/theme';
import {
    DEFAULT_DESKTOP_TEXT_SIZE_MODE,
    TEXT_SIZE_STORAGE_KEY,
    applyDesktopTextSize,
    coerceDesktopTextSize,
} from './lib/text-size';
import { useUiStore } from './store/ui-store';
import { useObsidianStore } from './store/obsidian-store';

const ProjectsView = import.meta.env.DEV
    ? ProjectsViewEager
    : lazy(() => import('./components/views/ProjectsView').then((m) => ({ default: m.ProjectsView })));
const SettingsView = lazy(wrapSettingsOpenImport(
    'settings-view-chunk',
    () => import('./components/views/SettingsView').then((m) => ({ default: m.SettingsView }))
));

function App() {
    const [currentView, setCurrentView] = useState('inbox');
    const [activeView, setActiveView] = useState('inbox');
    const [, startTransition] = useTransition();
    const fetchData = useTaskStore((state) => state.fetchData);
    const isLoading = useTaskStore((state) => state.isLoading);
    const setError = useTaskStore((state) => state.setError);
    const windowDecorations = useTaskStore((state) => state.settings?.window?.decorations);
    const closeBehavior = useTaskStore((state) => state.settings?.window?.closeBehavior ?? 'ask');
    const showTray = useTaskStore((state) => state.settings?.window?.showTray);
    const settingsTheme = useTaskStore((state) => state.settings?.theme);
    const settingsTextSize = useTaskStore((state) => state.settings?.appearance?.textSize);
    const settingsLanguage = useTaskStore((state) => state.settings?.language);
    const settingsDateFormat = useTaskStore((state) => state.settings?.dateFormat);
    const settingsTimeFormat = useTaskStore((state) => state.settings?.timeFormat);
    const updateSettings = useTaskStore((state) => state.updateSettings);
    const showToast = useUiStore((state) => state.showToast);
    const isFlatpak = isFlatpakRuntime();
    const { t, language, setLanguage } = useLanguage();
    const isActiveRef = useRef(true);
    const lastSyncErrorRef = useRef<string | null>(null);
    const lastSyncErrorAtRef = useRef(0);
    const [closePromptOpen, setClosePromptOpen] = useState(false);
    const [closePromptRemember, setClosePromptRemember] = useState(false);
    const [externalSyncChange, setExternalSyncChange] = useState<ExternalSyncChange | null>(null);
    const [resolvingExternalSync, setResolvingExternalSync] = useState(false);
    const [hasHydratedSettings, setHasHydratedSettings] = useState(false);
    const closePromptRememberRef = useRef(false);
    const lastViewBreadcrumbRef = useRef<string | null>(null);
    const isObsidianEnabled = useObsidianStore((state) => state.config.enabled);
    const obsidianVaultPath = useObsidianStore((state) => state.config.vaultPath);
    const startObsidianWatcher = useObsidianStore((state) => state.startWatcher);
    const stopObsidianWatcher = useObsidianStore((state) => state.stopWatcher);

    const setClosePromptRememberValue = useCallback((next: boolean) => {
        closePromptRememberRef.current = next;
        setClosePromptRemember(next);
    }, []);

    const resolveExternalSync = useCallback(async (resolution: ExternalSyncChangeResolution) => {
        setResolvingExternalSync(true);
        try {
            const result = await SyncService.resolveExternalSyncChange(resolution);
            if (result.success) {
                if (resolution === 'keep-local') {
                    showToast('Kept local changes and updated sync file.', 'success');
                } else if (resolution === 'use-external') {
                    showToast('Loaded external sync file changes.', 'success');
                } else {
                    const conflicts = (result.stats?.tasks.conflicts || 0) + (result.stats?.projects.conflicts || 0);
                    showToast(
                        conflicts > 0
                            ? `Sync merged with ${conflicts} conflict${conflicts === 1 ? '' : 's'} resolved.`
                            : 'Sync merged external changes.',
                        'success'
                    );
                }
                setExternalSyncChange(null);
                return;
            }
            showToast(result.error || 'Failed to resolve external sync change.', 'error');
        } finally {
            setResolvingExternalSync(false);
        }
    }, [showToast]);

    const persistCloseBehavior = useCallback(async (behavior: 'tray' | 'quit') => {
        await updateSettings({
            window: {
                ...(useTaskStore.getState().settings?.window ?? {}),
                closeBehavior: behavior,
            },
        });
        await flushPendingSave();
    }, [updateSettings]);

    useEffect(() => {
        const normalizedTheme = mapSyncedThemeToDesktop(settingsTheme);
        if (!normalizedTheme) return;
        localStorage.setItem(THEME_STORAGE_KEY, normalizedTheme);
        applyThemeMode(normalizedTheme);

        if (!isTauriRuntime()) return;
        const nativeTheme = resolveNativeTheme(normalizedTheme);
        import('@tauri-apps/api/app')
            .then(({ setTheme }) => setTheme(nativeTheme))
            .catch((error) => void logError(error, { scope: 'theme', step: 'apply' }));
    }, [settingsTheme]);

    useEffect(() => {
        if (!hasHydratedSettings) return;
        const normalizedTextSize = coerceDesktopTextSize(settingsTextSize);
        if (normalizedTextSize === DEFAULT_DESKTOP_TEXT_SIZE_MODE) {
            localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
        } else {
            localStorage.setItem(TEXT_SIZE_STORAGE_KEY, normalizedTextSize);
        }
        applyDesktopTextSize(normalizedTextSize);
    }, [hasHydratedSettings, settingsTextSize]);

    useEffect(() => {
        const normalizedTheme = mapSyncedThemeToDesktop(settingsTheme);
        if (normalizedTheme !== 'system') return;

        const stopWatchingSystemTheme = watchSystemThemePreference((theme) => {
            applyThemeMode('system', theme);
        });

        if (!isTauriRuntime()) {
            return () => {
                stopWatchingSystemTheme();
            };
        }

        const stopWatchingNativeTheme = watchNativeSystemThemePreference(
            () => import('@tauri-apps/api/window'),
            (theme) => {
                applyThemeMode('system', theme);
            },
            (step, error) => {
                void logError(error, { scope: 'theme', step });
            }
        );

        return () => {
            stopWatchingSystemTheme();
            stopWatchingNativeTheme();
        };
    }, [settingsTheme]);

    useEffect(() => {
        if (!settingsLanguage || !isSupportedLanguage(settingsLanguage)) return;
        if (settingsLanguage === language) return;
        setLanguage(settingsLanguage);
    }, [settingsLanguage, language, setLanguage]);

    useEffect(() => {
        const next = `view:${currentView}`;
        if (lastViewBreadcrumbRef.current === next) return;
        lastViewBreadcrumbRef.current = next;
        addBreadcrumb(next);
    }, [currentView]);

    useEffect(() => {
        const systemLocale = (() => {
            const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
            return String(candidates?.[0] || '').trim();
        })();
        configureDateFormatting({
            language: settingsLanguage || language,
            dateFormat: settingsDateFormat,
            timeFormat: settingsTimeFormat,
            systemLocale,
        });
    }, [language, settingsDateFormat, settingsLanguage, settingsTimeFormat]);

    const translateOrFallback = useCallback((key: string, fallback: string) => {
        const value = t(key);
        return value === key ? fallback : value;
    }, [t]);

    const hideToTray = useCallback(async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow();
        try {
            await window.setSkipTaskbar(true);
        } catch (error) {
            void logError(error, { scope: 'window', step: 'setSkipTaskbar' });
        }
        await window.hide();
    }, []);

    const quitApp = useCallback(async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('quit_app');
    }, []);

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        let cancelled = false;
        fetchData()
            .finally(() => {
                if (!cancelled) {
                    setHasHydratedSettings(true);
                }
            });
        useObsidianStore.getState().loadConfig().catch((error) => reportError('Obsidian init failed', error));
        const unsubscribeExternalSync = SyncService.subscribeExternalSyncChange(setExternalSyncChange);

        const reportError = (label: string, error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            setError(`${label}: ${message}`);
            void logError(error, { scope: 'app', step: label });
        };

        const handleUnload = () => {
            flushPendingSave().catch((error) => reportError('Save failed', error));
        };
        window.addEventListener('beforeunload', handleUnload);
        let unlistenClose: (() => void) | null = null;
        let closingPromise: Promise<void> | null = null;
        let isClosing = false;
        let disposed = false;
        if (isTauriRuntime()) {
            import('@tauri-apps/api/window')
                .then(async ({ getCurrentWindow }) => {
                    const window = getCurrentWindow();
                    const unlisten = await window.onCloseRequested(async (event) => {
                        if (closingPromise || isClosing) return;
                        isClosing = true;
                        event.preventDefault();
                        closingPromise = flushPendingSave()
                            .catch((error) => reportError('Save failed', error))
                            .finally(() => {
                                closingPromise = null;
                                isClosing = false;
                            });
                        await closingPromise;
                    });
                    if (disposed) {
                        unlisten();
                    } else {
                        unlistenClose = unlisten;
                    }
                })
                .catch((error) => reportError('Window listener failed', error));
        }

        if (isTauriRuntime()) {
            startDesktopNotifications().catch((error) => reportError('Notifications failed', error));
            SyncService.startFileWatcher().catch((error) => reportError('File watcher failed', error));

            // Watch local data.json for external changes (e.g. from the CLI)
            import('@tauri-apps/api/core')
                .then((mod) => mod.invoke<string>('get_data_path_cmd'))
                .then((dataPath) => LocalDataWatcher.start(dataPath))
                .catch((error) => reportError('Local data watcher failed', error));
        }

        isActiveRef.current = true;

        const performSync = async () => {
            return SyncService.performSync();
        };

        const handleSyncFailure = (message: string) => {
            const nowMs = Date.now();
            const isSameError = message === lastSyncErrorRef.current;
            // Throttle repeated identical errors to once per 2 minutes, but always
            // show new/different error messages immediately so the user stays informed.
            const shouldAlert = !isSameError || nowMs - lastSyncErrorAtRef.current > 2 * 60 * 1000;
            if (shouldAlert) {
                lastSyncErrorRef.current = message;
                lastSyncErrorAtRef.current = nowMs;
                showToast(`Sync failed: ${message}`, 'error', 6000);
            }
        };

        const autoSyncController = createDesktopAutoSyncController({
            canSync: () => canDesktopAutoSync(SyncService),
            performSync,
            flushPendingSave,
            reportError,
            onSyncFailure: handleSyncFailure,
            isRuntimeActive: () => isActiveRef.current && isTauriRuntime(),
            shouldPauseWindowSync: () => (
                useTaskStore.getState().editLockCount > 0
                || useUiStore.getState().editingTaskId !== null
            ),
        });

        const focusListener = () => {
            autoSyncController.handleFocus();
        };

        const blurListener = () => {
            autoSyncController.handleBlur();
        };

        const storeUnsubscribe = useTaskStore.subscribe((state, prevState) => {
            if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
            autoSyncController.handleDataChange();
        });

        window.addEventListener('focus', focusListener);
        window.addEventListener('blur', blurListener);
        autoSyncController.scheduleInitialSync();

        return () => {
            cancelled = true;
            disposed = true;
            isActiveRef.current = false;
            window.removeEventListener('beforeunload', handleUnload);
            window.removeEventListener('focus', focusListener);
            window.removeEventListener('blur', blurListener);
            if (unlistenClose) {
                unlistenClose();
            }
            storeUnsubscribe();
            autoSyncController.dispose();
            stopDesktopNotifications();
            LocalDataWatcher.stop();
            SyncService.stopFileWatcher().catch((error) => reportError('File watcher failed', error));
            unsubscribeExternalSync();
        };
    }, [fetchData, setError, showToast]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        let unlisten: (() => void) | undefined;
        const reportCloseError = (label: string, error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            setError(`${label}: ${message}`);
            void logError(error, { scope: 'app', step: label });
        };

        const setup = async () => {
            const { listen } = await import('@tauri-apps/api/event');
            const { invoke } = await import('@tauri-apps/api/core');
            unlisten = await listen('close-requested', async () => {
                await invoke('acknowledge_close_request').catch((error) => {
                    void logError(error, { scope: 'app', step: 'acknowledgeCloseRequest' });
                });
                if (isFlatpak) {
                    await quitApp().catch((error) => reportCloseError('Quit failed', error));
                    return;
                }
                if (closeBehavior === 'quit') {
                    await quitApp().catch((error) => reportCloseError('Quit failed', error));
                    return;
                }
                if (closeBehavior === 'tray') {
                    // If tray is hidden, quit instead of trying to hide to an invisible tray
                    if (showTray === false) {
                        await quitApp().catch((error) => reportCloseError('Quit failed', error));
                        return;
                    }
                    await hideToTray().catch((error) => reportCloseError('Hide failed', error));
                    return;
                }
                if (!closePromptOpen) {
                    setClosePromptRememberValue(false);
                    setClosePromptOpen(true);
                }
            });
        };

        setup().catch((error) => reportCloseError('Close listener failed', error));

        return () => {
            if (unlisten) unlisten();
        };
    }, [closeBehavior, closePromptOpen, hideToTray, isFlatpak, quitApp, setClosePromptRememberValue, setError, showTray]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        if (windowDecorations === undefined) return;
        if (!/linux/i.test(navigator.userAgent || '')) return;
        let cancelled = false;
        import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) => {
                if (cancelled) return;
                return getCurrentWindow().setDecorations(windowDecorations);
            })
            .catch((error) => void logError(error, { scope: 'window', step: 'setDecorations' }));
        return () => {
            cancelled = true;
        };
    }, [windowDecorations]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        if (!isObsidianEnabled || !obsidianVaultPath) {
            void stopObsidianWatcher().catch((error) => void logError(error, { scope: 'obsidian', step: 'stopWatcher' }));
            return;
        }

        void startObsidianWatcher().catch((error) => void logError(error, { scope: 'obsidian', step: 'startWatcher' }));

        return () => {
            void stopObsidianWatcher().catch((error) => void logError(error, { scope: 'obsidian', step: 'stopWatcher' }));
        };
    }, [isObsidianEnabled, obsidianVaultPath, startObsidianWatcher, stopObsidianWatcher]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        if (showTray === undefined) return;
        let cancelled = false;
        import('@tauri-apps/api/core')
            .then(async ({ invoke }) => {
                if (cancelled) return;
                await invoke('set_tray_visible', { visible: showTray !== false });
            })
            .catch((error) => void logError(error, { scope: 'tray', step: 'setVisible' }));
        return () => {
            cancelled = true;
        };
    }, [showTray]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        const hideFromDock = closeBehavior === 'tray' && showTray !== false;
        let cancelled = false;
        import('@tauri-apps/api/core')
            .then(async ({ invoke }) => {
                if (cancelled) return;
                await invoke('set_macos_activation_policy', { accessory: hideFromDock });
            })
            .catch((error) => void logError(error, { scope: 'window', step: 'setActivationPolicy' }));
        return () => {
            cancelled = true;
        };
    }, [closeBehavior, showTray]);

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        // Settings is frequently opened from menu actions; preload it eagerly to avoid first-open delay.
        void import('./components/views/SettingsView');
        const idleCallback =
            (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
            ?? ((cb: () => void) => window.setTimeout(cb, 200));
        const idleCancel =
            (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
            ?? ((id: number) => window.clearTimeout(id));
        const id = idleCallback(() => {
            void import('./components/views/BoardView');
            void import('./components/views/ObsidianView');
            if (!import.meta.env.DEV) {
                void import('./components/views/ProjectsView');
            }
            void import('./components/views/ReviewView');
        });
        return () => idleCancel(id);
    }, []);

    const renderView = () => {
        if (activeView.startsWith('savedSearch:')) {
            const savedSearchId = activeView.replace('savedSearch:', '');
            return <SearchView savedSearchId={savedSearchId} />;
        }
        switch (activeView) {
            case 'inbox':
                return <ListView title={t('list.inbox')} statusFilter="inbox" />;
            case 'agenda':
                return <AgendaView />;
            case 'next':
                return <AgendaView />;
            case 'someday':
                return <ListView title={t('list.someday')} statusFilter="someday" />;
            case 'reference':
                return <ListView title={t('list.reference')} statusFilter="reference" />;
            case 'waiting':
                return <ListView title={t('list.waiting')} statusFilter="waiting" />;
            case 'done':
                return <ListView title={t('list.done')} statusFilter="done" />;
            case 'calendar':
                return <CalendarView />;
            case 'board':
                return <BoardView />;
            case 'obsidian':
                return <ObsidianView />;
            case 'projects':
                return <ProjectsView />;
            case 'contexts':
                return <ContextsView />;
            case 'review':
                return <ReviewView />;
            case 'settings':
                return <SettingsView />;
            case 'archived':
                return <ArchiveView />;
            case 'trash':
                return <TrashView />;
            default:
                return <ListView title={t('list.inbox')} statusFilter="inbox" />;
        }
    };

    const handleViewChange = useCallback((view: string) => {
        const nextView = view === 'obsidian' && !useObsidianStore.getState().config.enabled ? 'settings' : view;
        setCurrentView(nextView);
        if (nextView === 'settings') {
            beginSettingsOpenTrace('handleViewChange');
            setActiveView(nextView);
            return;
        }
        startTransition(() => {
            setActiveView(nextView);
        });
    }, [startTransition]);

    useEffect(() => {
        if (isObsidianEnabled || currentView !== 'obsidian') return;
        handleViewChange('settings');
    }, [currentView, handleViewChange, isObsidianEnabled]);

    const LoadingFallback = ({ view }: { view: string }) => {
        useEffect(() => {
            if (view !== 'settings') return;
            markSettingsOpenTrace('app-suspense-fallback-mounted');
        }, [view]);

        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <div className="w-full max-w-md space-y-3">
                    <div className="h-4 w-2/3 rounded bg-muted/60 animate-pulse" />
                    <div className="h-4 w-5/6 rounded bg-muted/50 animate-pulse" />
                    <div className="h-4 w-1/2 rounded bg-muted/40 animate-pulse" />
                </div>
            </div>
        );
    };

    useEffect(() => {
        const handler: EventListener = (event) => {
            const detail = (event as CustomEvent<{ view?: string }>).detail;
            if (detail?.view) {
                handleViewChange(detail.view);
            }
        };
        window.addEventListener('mindwtr:navigate', handler);
        return () => window.removeEventListener('mindwtr:navigate', handler);
    }, [handleViewChange]);

    return (
        <ErrorBoundary>
            <KeybindingProvider currentView={currentView} onNavigate={handleViewChange}>
                <Layout currentView={currentView} onViewChange={handleViewChange}>
                    <Suspense
                        fallback={(
                            <LoadingFallback view={activeView} />
                        )}
                    >
                        {isLoading ? (
                            <LoadingFallback view={activeView} />
                        ) : (
                            renderView()
                        )}
                    </Suspense>
                    <GlobalSearch onNavigate={(view, _id) => handleViewChange(view)} />
                    <QuickAddModal />
                    <CloseBehaviorModal
                        isOpen={closePromptOpen}
                        title={translateOrFallback('settings.closeBehaviorPromptTitle', 'Close Mindwtr?')}
                        description={translateOrFallback(
                            'settings.closeBehaviorPromptBody',
                            'Do you want Mindwtr to stay running in the tray or quit completely?'
                        )}
                        rememberLabel={translateOrFallback('settings.closeBehaviorRemember', "Don't ask again")}
                        stayLabel={translateOrFallback('settings.closeBehaviorTray', 'Keep running in tray')}
                        quitLabel={translateOrFallback('settings.closeBehaviorQuit', 'Quit the app')}
                        cancelLabel={translateOrFallback('common.cancel', 'Cancel')}
                        remember={closePromptRemember}
                        onRememberChange={setClosePromptRememberValue}
                        onCancel={() => setClosePromptOpen(false)}
                        onStay={() => {
                            const apply = async () => {
                                if (closePromptRememberRef.current) {
                                    await persistCloseBehavior('tray');
                                }
                                setClosePromptOpen(false);
                                await hideToTray();
                            };
                            apply().catch((error) => {
                                setClosePromptOpen(false);
                                void logError(error, { scope: 'app', step: 'close-tray' });
                            });
                        }}
                        onQuit={() => {
                            const apply = async () => {
                                if (closePromptRememberRef.current) {
                                    await persistCloseBehavior('quit');
                                }
                                setClosePromptOpen(false);
                                await quitApp();
                            };
                            apply().catch((error) => {
                                setClosePromptOpen(false);
                                void logError(error, { scope: 'app', step: 'close-quit' });
                            });
                        }}
                    />
                    {externalSyncChange && (
                        <div
                            className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh] z-50"
                            role="dialog"
                            aria-modal="true"
                            onClick={() => !resolvingExternalSync && setExternalSyncChange(null)}
                        >
                            <div
                                className="w-full max-w-lg bg-popover text-popover-foreground rounded-xl border shadow-2xl overflow-hidden flex flex-col"
                                onClick={(event) => event.stopPropagation()}
                            >
                                <div className="px-4 py-3 border-b">
                                    <h3 className="font-semibold">
                                        {translateOrFallback('settings.externalSyncChangeTitle', 'External sync change detected')}
                                    </h3>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        {translateOrFallback(
                                            'settings.externalSyncChangeBody',
                                            'The sync file changed while local edits were pending. Choose how to continue.'
                                        )}
                                    </p>
                                    <p className="text-xs text-muted-foreground mt-2">
                                        {translateOrFallback('settings.lastSync', 'Last sync')}: {externalSyncChange.lastSyncAt || translateOrFallback('settings.lastSyncNever', 'Never')}
                                    </p>
                                </div>
                                <div className="p-4 flex flex-wrap justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setExternalSyncChange(null)}
                                        disabled={resolvingExternalSync}
                                        className="px-3 py-1.5 rounded-md text-sm bg-muted hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {translateOrFallback('common.reviewLater', 'Review later')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => resolveExternalSync('use-external')}
                                        disabled={resolvingExternalSync}
                                        className="px-3 py-1.5 rounded-md text-sm bg-muted hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {translateOrFallback('settings.useExternal', 'Use external')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => resolveExternalSync('merge')}
                                        disabled={resolvingExternalSync}
                                        className="px-3 py-1.5 rounded-md text-sm bg-secondary text-secondary-foreground hover:bg-secondary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {translateOrFallback('settings.mergeChanges', 'Merge')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => resolveExternalSync('keep-local')}
                                        disabled={resolvingExternalSync}
                                        className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {translateOrFallback('settings.keepLocal', 'Keep local')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </Layout>
            </KeybindingProvider>
        </ErrorBoundary>
    );
}

export default App;
