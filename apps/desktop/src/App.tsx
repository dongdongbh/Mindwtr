import { useEffect, useState, useRef } from 'react';
import { Layout } from './components/Layout';
import { ListView } from './components/views/ListView';
import { CalendarView } from './components/views/CalendarView';
import { BoardView } from './components/views/BoardView';
import { ProjectsView } from './components/views/ProjectsView';
import { ContextsView } from './components/views/ContextsView';
import { ReviewView } from './components/views/ReviewView';
import { TutorialView } from './components/views/TutorialView';
import { SettingsView } from './components/views/SettingsView';
import { ArchiveView } from './components/views/ArchiveView';
import { TrashView } from './components/views/TrashView';
import { AgendaView } from './components/views/AgendaView';
import { SearchView } from './components/views/SearchView';
import { useTaskStore, flushPendingSave } from '@mindwtr/core';
import { GlobalSearch } from './components/GlobalSearch';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useLanguage } from './contexts/language-context';
import { KeybindingProvider } from './contexts/keybinding-context';
import { QuickAddModal } from './components/QuickAddModal';
import { startDesktopNotifications, stopDesktopNotifications } from './lib/notification-service';
import { SyncService } from './lib/sync-service';
import { isTauriRuntime } from './lib/runtime';

function App() {
    const [currentView, setCurrentView] = useState('inbox');
    const { fetchData } = useTaskStore();
    const { t } = useLanguage();
    const isActiveRef = useRef(true);
    const lastAutoSyncRef = useRef(0);
    const syncDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const initialSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const syncInFlightRef = useRef<Promise<void> | null>(null);
    const syncQueuedRef = useRef(false);
    const lastSyncErrorRef = useRef<string | null>(null);
    const lastSyncErrorAtRef = useRef(0);

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        fetchData();

        const handleUnload = () => {
            flushPendingSave().catch(console.error);
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
                            .catch(console.error)
                            .then(() => window.close())
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
                .catch(console.error);
        }

        if (isTauriRuntime()) {
            startDesktopNotifications().catch(console.error);
            SyncService.startFileWatcher().catch(console.error);
        }

        isActiveRef.current = true;

        const canSync = async () => {
            const backend = await SyncService.getSyncBackend();
            if (backend === 'file') {
                const path = await SyncService.getSyncPath();
                return Boolean(path);
            }
            if (backend === 'webdav') {
                const { url } = await SyncService.getWebDavConfig();
                return Boolean(url);
            }
            return false;
        };

        const performSync = async () => {
            if (!isActiveRef.current || !isTauriRuntime()) return;
            const now = Date.now();
            if (now - lastAutoSyncRef.current < 5_000) return;
            if (!(await canSync())) return;

            lastAutoSyncRef.current = now;
            await flushPendingSave().catch(console.error);
            const result = await SyncService.performSync();
            if (!result.success && result.error) {
                const nowMs = Date.now();
                const shouldAlert = result.error !== lastSyncErrorRef.current || nowMs - lastSyncErrorAtRef.current > 10 * 60 * 1000;
                if (shouldAlert) {
                    lastSyncErrorRef.current = result.error;
                    lastSyncErrorAtRef.current = nowMs;
                    window.alert(`Sync failed:\n${result.error}`);
                }
            }
        };

        const queueSync = async () => {
            if (!isActiveRef.current || !isTauriRuntime()) return;
            if (syncInFlightRef.current) {
                syncQueuedRef.current = true;
                return;
            }
            syncInFlightRef.current = performSync()
                .catch(console.error)
                .finally(() => {
                    syncInFlightRef.current = null;
                    if (syncQueuedRef.current && isActiveRef.current) {
                        syncQueuedRef.current = false;
                        void queueSync();
                    }
                });
            await syncInFlightRef.current;
        };

        const focusListener = () => {
            // On focus, use 30s throttle to avoid excessive syncs
            const now = Date.now();
            if (now - lastAutoSyncRef.current > 30_000) {
                queueSync().catch(console.error);
            }
        };

        const blurListener = () => {
            // Sync when window loses focus
            flushPendingSave().catch(console.error);
            queueSync().catch(console.error);
        };

        // Auto-sync on data changes with debounce
        const storeUnsubscribe = useTaskStore.subscribe((state, prevState) => {
            if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
            if (syncDebounceTimerRef.current) {
                clearTimeout(syncDebounceTimerRef.current);
            }
            syncDebounceTimerRef.current = setTimeout(() => {
                if (!isActiveRef.current) return;
                queueSync().catch(console.error);
            }, 5000);
        });

        // Background/on-resume sync (focus/blur) and initial auto-sync
        window.addEventListener('focus', focusListener);
        window.addEventListener('blur', blurListener);
        initialSyncTimerRef.current = setTimeout(() => {
            if (!isActiveRef.current) return;
            queueSync().catch(console.error);
        }, 1500);

        return () => {
            disposed = true;
            isActiveRef.current = false;
            window.removeEventListener('beforeunload', handleUnload);
            window.removeEventListener('focus', focusListener);
            window.removeEventListener('blur', blurListener);
            if (unlistenClose) {
                unlistenClose();
            }
            storeUnsubscribe();
            if (syncDebounceTimerRef.current) {
                clearTimeout(syncDebounceTimerRef.current);
            }
            if (initialSyncTimerRef.current) {
                clearTimeout(initialSyncTimerRef.current);
            }
            stopDesktopNotifications();
            SyncService.stopFileWatcher().catch(console.error);
        };
    }, [fetchData]);

    const renderView = () => {
        if (currentView.startsWith('savedSearch:')) {
            const savedSearchId = currentView.replace('savedSearch:', '');
            return <SearchView savedSearchId={savedSearchId} />;
        }
        switch (currentView) {
            case 'inbox':
                return <ListView title={t('list.inbox')} statusFilter="inbox" />;
            case 'agenda':
                return <AgendaView />;
            case 'next':
                return <AgendaView />;
            case 'someday':
                return <ListView title={t('list.someday')} statusFilter="someday" />;
            case 'waiting':
                return <ListView title={t('list.waiting')} statusFilter="waiting" />;
            case 'done':
                return <ListView title={t('list.done')} statusFilter="done" />;
            case 'calendar':
                return <CalendarView />;
            case 'board':
                return <BoardView />;
            case 'projects':
                return <ProjectsView />;
            case 'contexts':
                return <ContextsView />;
            case 'review':
                return <ReviewView />;
            case 'tutorial':
                return <TutorialView />;
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

    return (
        <ErrorBoundary>
            <KeybindingProvider currentView={currentView} onNavigate={setCurrentView}>
                <Layout currentView={currentView} onViewChange={setCurrentView}>
                    {renderView()}
                    <GlobalSearch onNavigate={(view, _id) => setCurrentView(view)} />
                    <QuickAddModal />
                </Layout>
            </KeybindingProvider>
        </ErrorBoundary>
    );
}

export default App;
