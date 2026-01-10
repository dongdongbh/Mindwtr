import { useEffect, useState } from 'react';
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

    useEffect(() => {
        if (import.meta.env.MODE === 'test' || import.meta.env.VITEST || process.env.NODE_ENV === 'test') return;
        fetchData();

        const handleUnload = () => {
            flushPendingSave().catch(console.error);
        };
        window.addEventListener('beforeunload', handleUnload);
        let unlistenClose: (() => void) | null = null;
        let isClosing = false;
        if (isTauriRuntime()) {
            import('@tauri-apps/api/window')
                .then(async ({ getCurrentWindow }) => {
                    const window = getCurrentWindow();
                    unlistenClose = await window.onCloseRequested(async (event) => {
                        if (isClosing) return;
                        isClosing = true;
                        event.preventDefault();
                        await flushPendingSave().catch(console.error);
                        await window.close();
                    });
                })
                .catch(console.error);
        }

        if (isTauriRuntime()) {
            startDesktopNotifications().catch(console.error);
            SyncService.startFileWatcher().catch(console.error);
        }

        let isActive = true;
        let lastAutoSync = 0;
        let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
        let initialSyncTimer: ReturnType<typeof setTimeout> | null = null;
        let syncInFlight: Promise<void> | null = null;
        let syncQueued = false;
        let lastSyncError: string | null = null;
        let lastSyncErrorAt = 0;

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
            if (!isActive || !isTauriRuntime()) return;
            const now = Date.now();
            if (now - lastAutoSync < 5_000) return;
            if (!(await canSync())) return;

            lastAutoSync = now;
            await flushPendingSave().catch(console.error);
            const result = await SyncService.performSync();
            if (!result.success && result.error) {
                const nowMs = Date.now();
                const shouldAlert = result.error !== lastSyncError || nowMs - lastSyncErrorAt > 10 * 60 * 1000;
                if (shouldAlert) {
                    lastSyncError = result.error;
                    lastSyncErrorAt = nowMs;
                    window.alert(`Sync failed:\n${result.error}`);
                }
            }
        };

        const queueSync = async () => {
            if (!isActive || !isTauriRuntime()) return;
            if (syncInFlight) {
                syncQueued = true;
                return;
            }
            syncInFlight = performSync()
                .catch(console.error)
                .finally(() => {
                    syncInFlight = null;
                    if (syncQueued && isActive) {
                        syncQueued = false;
                        void queueSync();
                    }
                });
            await syncInFlight;
        };

        const focusListener = () => {
            // On focus, use 30s throttle to avoid excessive syncs
            const now = Date.now();
            if (now - lastAutoSync > 30_000) {
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
            if (syncDebounceTimer) {
                clearTimeout(syncDebounceTimer);
            }
            syncDebounceTimer = setTimeout(() => {
                if (!isActive) return;
                queueSync().catch(console.error);
            }, 5000);
        });

        // Background/on-resume sync (focus/blur) and initial auto-sync
        window.addEventListener('focus', focusListener);
        window.addEventListener('blur', blurListener);
        initialSyncTimer = setTimeout(() => {
            if (!isActive) return;
            queueSync().catch(console.error);
        }, 1500);

        return () => {
            isActive = false;
            window.removeEventListener('beforeunload', handleUnload);
            window.removeEventListener('focus', focusListener);
            window.removeEventListener('blur', blurListener);
            if (unlistenClose) {
                unlistenClose();
            }
            storeUnsubscribe();
            if (syncDebounceTimer) {
                clearTimeout(syncDebounceTimer);
            }
            if (initialSyncTimer) {
                clearTimeout(initialSyncTimer);
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
