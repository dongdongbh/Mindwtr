import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useTaskStore, type MergeStats } from '@mindwtr/core';

import { LanguageProvider } from '../contexts/language-context';
import { KeybindingProvider } from '../contexts/keybinding-context';
import { useUiStore } from '../store/ui-store';
import { useObsidianStore } from '../store/obsidian-store';
import { SyncService } from '../lib/sync-service';
import { CALENDAR_TASK_DRAG_MIME } from '../lib/calendar-task-drag';
import { Layout } from './Layout';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();
const initialObsidianState = useObsidianStore.getState();
const onNavigate = vi.fn();

const dispatchDrag = (type: string, withTaskData: boolean) => act(() => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', {
        value: { types: withTaskData ? [CALENDAR_TASK_DRAG_MIME] : ['text/plain'], getData: () => '' },
    });
    document.dispatchEvent(event);
});

// A real drag starts on a task row deep in the tree, and that row fills the
// transfer in its OWN dragstart handler. Dispatching straight at document would
// hide an ordering bug — a capture-phase listener runs before the row and sees an
// empty transfer, so the drag goes unrecognised and nothing lights up. Both the
// source element and that timing are reproduced here.
const dispatchDragStartFromRow = (withTaskData: boolean) => act(() => {
    const source = document.createElement('div');
    document.body.appendChild(source);
    const types: string[] = [];
    source.addEventListener('dragstart', () => {
        if (withTaskData) types.push(CALENDAR_TASK_DRAG_MIME);
    });
    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types, getData: () => '' } });
    source.dispatchEvent(event);
    source.remove();
});

const createMergeStats = (conflictIds: string[] = []): MergeStats => {
    const emptyStats = {
        localTotal: 0,
        incomingTotal: 0,
        mergedTotal: 0,
        localOnly: 0,
        incomingOnly: 0,
        conflicts: 0,
        resolvedUsingLocal: 0,
        resolvedUsingIncoming: 0,
        deletionsWon: 0,
        conflictIds: [],
        maxClockSkewMs: 0,
        invalidTimestamps: 0,
        timestampAdjustments: 0,
        timestampAdjustmentIds: [],
        futureTimestampClamps: 0,
        futureTimestampClampIds: [],
        conflictReasonCounts: {},
        conflictSamples: [],
    };
    return {
        tasks: {
            ...emptyStats,
            conflicts: conflictIds.length,
            conflictIds,
            conflictSamples: conflictIds.map((id) => ({
                id,
                winner: 'local',
                reasons: ['content'],
                hasRevision: true,
                timeDiffMs: 0,
                localUpdatedAt: '2026-04-22T12:00:00.000Z',
                incomingUpdatedAt: '2026-04-22T12:00:00.000Z',
                localRev: 1,
                incomingRev: 1,
                localComparableHash: `local-${id}`,
                incomingComparableHash: `incoming-${id}`,
                diffKeys: ['title'],
            })),
        },
        projects: { ...emptyStats },
        sections: { ...emptyStats },
        areas: { ...emptyStats },
    };
};

const renderLayout = (currentView = 'inbox', onViewChange = vi.fn()) => render(
    <LanguageProvider>
        <KeybindingProvider currentView={currentView} onNavigate={onNavigate}>
            <Layout currentView={currentView} onViewChange={onViewChange}>
                <div>Main content</div>
            </Layout>
        </KeybindingProvider>
    </LanguageProvider>
);

const resetStores = () => {
    act(() => {
        useTaskStore.setState(initialTaskState, true);
        useUiStore.setState(initialUiState, true);
        useObsidianStore.setState(initialObsidianState, true);
    });
};

beforeEach(() => {
    window.localStorage.clear();
    resetStores();
    // Pin a sync-enabled backend so footer/toast assertions don't race the async
    // backend read (jsdom's persisted default is 'off', which hides the footer).
    vi.spyOn(SyncService, 'refreshSyncBackendStatus').mockResolvedValue();
    vi.spyOn(SyncService, 'subscribeSyncStatus').mockImplementation(() => () => undefined);
    vi.spyOn(SyncService, 'getSyncStatus').mockReturnValue({
        inFlight: false,
        queued: false,
        step: null,
        lastResult: null,
        lastResultAt: null,
        backend: 'file',
    });
    act(() => {
        useTaskStore.setState((state) => ({
            ...state,
            _allTasks: [],
            _allProjects: [],
            _allAreas: [],
            settings: {
                ...state.settings,
                sidebarCollapsed: false,
                filters: {
                    ...(state.settings?.filters ?? {}),
                    areaId: 'all',
                },
            },
            error: null,
        }));
        useUiStore.setState((state) => ({
            ...state,
            isFocusMode: false,
        }));
        useObsidianStore.setState((state) => ({
            ...state,
            config: {
                ...state.config,
                enabled: false,
            },
            isInitialized: true,
        }));
    });
});

afterEach(() => {
    cleanup();
    resetStores();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('Layout content width', () => {
    // This width has flipped between list-width, edge-to-edge, and back once already
    // (#966). jsdom cannot measure it, so pin both halves: wider than a list view,
    // still capped so the grid keeps its side margins.
    it('gives the calendar a wider cap than list views without going edge-to-edge', () => {
        const { container } = renderLayout('calendar');
        const content = container.querySelector('[data-main-content] > div');

        expect(content).toHaveClass('w-full', 'max-w-screen-2xl');
        expect(content).not.toHaveClass('max-w-none');
        expect(content).not.toHaveClass('max-w-6xl');
    });

    it('leaves list views on the narrower cap', () => {
        const { container } = renderLayout('next');
        const content = container.querySelector('[data-main-content] > div');

        expect(content).toHaveClass('max-w-6xl');
        expect(content).not.toHaveClass('max-w-screen-2xl');
    });

    // This box is `h-full`, so bottom padding here is a dead band below views
    // that scroll inside it and is skipped entirely by views that overflow it
    // (#977). Views own their end gap; jsdom cannot measure, so pin the classes.
    it('keeps bottom padding off the shared content wrapper', () => {
        const { container } = renderLayout('next');
        const content = container.querySelector('[data-main-content] > div');
        const classNames = (content?.className ?? '').split(/\s+/).filter(Boolean);

        expect(classNames.filter((name) => /^(lg:|2xl:)?p-\d/.test(name))).toEqual([]);
        expect(classNames.filter((name) => /^(lg:|2xl:)?p[by]-/.test(name))).toEqual([]);
        expect(content).toHaveClass('px-4', 'pt-4', 'lg:px-6', 'lg:pt-6');
    });
});

describe('Layout sidebar archive section', () => {
    it('keeps archive visible by default on a fresh sidebar', () => {
        const { container, getByRole } = renderLayout();

        expect(getByRole('button', { name: 'Archive' })).toHaveAttribute('aria-expanded', 'true');
        expect(container.querySelector('#sidebar-section-archive')).not.toHaveClass('hidden');
        expect(getByRole('button', { name: 'Done' })).toBeInTheDocument();
    });

    it('expands archive when the active view lives in archive', async () => {
        const { container, getByRole } = renderLayout('trash');

        await waitFor(() => {
            expect(getByRole('button', { name: 'Archive' })).toHaveAttribute('aria-expanded', 'true');
            expect(container.querySelector('#sidebar-section-archive')).not.toHaveClass('hidden');
        });
        expect(getByRole('button', { name: 'Trash' })).toHaveAttribute('aria-current', 'page');
    });

    it('respects a stored collapsed archive preference', () => {
        window.localStorage.setItem('mindwtr:sidebar:collapsedSections', JSON.stringify(['archive']));

        const { container, getByRole } = renderLayout();

        expect(getByRole('button', { name: 'Archive' })).toHaveAttribute('aria-expanded', 'false');
        expect(container.querySelector('#sidebar-section-archive')).toHaveClass('hidden');
    });

    it('uses the full archive header row as the collapse target', () => {
        const { container, getByRole } = renderLayout();
        const archiveHeader = getByRole('button', { name: 'Archive' });

        expect(archiveHeader).toHaveAttribute('aria-controls', 'sidebar-section-archive');
        fireEvent.click(archiveHeader);

        expect(archiveHeader).toHaveAttribute('aria-expanded', 'false');
        expect(container.querySelector('#sidebar-section-archive')).toHaveClass('hidden');
    });
});

describe('Layout Obsidian nav visibility', () => {
    it('opens global inbox capture from the visible Add Task button', () => {
        const quickAddListener = vi.fn();
        window.addEventListener('mindwtr:quick-add', quickAddListener);
        const { getByRole } = renderLayout();
        const addTaskButton = getByRole('button', { name: 'Add Task (Inbox)' });

        expect(addTaskButton).toHaveAttribute('title', 'Add Task (Inbox)');
        expect(addTaskButton).toHaveClass('bg-primary/5');
        expect(addTaskButton).toHaveClass('text-primary');

        fireEvent.click(addTaskButton);

        expect(quickAddListener).toHaveBeenCalledTimes(1);
        expect(quickAddListener.mock.calls[0][0]).toMatchObject({
            detail: { initialProps: { status: 'inbox' } },
        });

        window.removeEventListener('mindwtr:quick-add', quickAddListener);
    });

    it('hides Obsidian when the integration is disabled', () => {
        const { queryByRole } = renderLayout();

        expect(queryByRole('button', { name: 'Obsidian' })).not.toBeInTheDocument();
    });

    it('shows Obsidian when the integration is enabled', () => {
        act(() => {
            useObsidianStore.setState((state) => ({
                ...state,
                config: {
                    ...state.config,
                    enabled: true,
                },
            }));
        });

        const { getByRole } = renderLayout();

        expect(getByRole('button', { name: 'Obsidian' })).toBeInTheDocument();
    });
});

describe('Layout sync conflict surface', () => {
    // A cycle that queues a follow-up leaves inFlight false while queued is true. If the
    // footer only watched inFlight it would re-enable the button and drop animate-spin for
    // that gap, flickering the cursor, hover background and spinner on every hand-off.
    it('keeps the footer busy while a follow-up sync is queued but not yet in flight', () => {
        const statusSpy = vi.spyOn(SyncService, 'getSyncStatus').mockReturnValue({
            inFlight: false,
            queued: true,
            step: null,
            lastResult: null,
            lastResultAt: null,
        } as ReturnType<typeof SyncService.getSyncStatus>);
        const subscribeSpy = vi
            .spyOn(SyncService, 'subscribeSyncStatus')
            .mockImplementation(() => () => undefined);

        const { container, getByRole } = renderLayout();

        expect(getByRole('button', { name: /Sync now/i })).toBeDisabled();
        expect(container.querySelector('[data-sidebar-sync-dot]')).toHaveClass('animate-pulse');

        statusSpy.mockRestore();
        subscribeSpy.mockRestore();
    });

    it('keeps Settings, sync status, and manual sync on one compact footer row', () => {
        const { container, getByRole } = renderLayout();

        const footer = container.querySelector('[data-sidebar-footer]');
        const settingsButton = getByRole('button', { name: 'Settings' });
        const syncStatusButton = container.querySelector('[data-sidebar-sync-status]');
        const syncButton = getByRole('button', { name: /Sync now/i });

        expect(footer).toHaveClass('py-1.5');
        expect(settingsButton).toHaveClass('h-9');
        expect(syncStatusButton).toHaveClass('h-9');
        expect(syncButton).toHaveClass('h-9');
        expect(settingsButton.parentElement).toBe(syncStatusButton?.parentElement);
        expect(syncButton.parentElement).toBe(syncStatusButton?.parentElement);
    });

    it('uses a colored dot for sync freshness without squeezing status text into the footer', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-22T12:10:00.000Z'));
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:05:00.000Z',
                    lastSyncStatus: 'success',
                },
            }));
        });

        const { container, getByRole, getByText } = renderLayout();
        const syncStatusButton = getByRole('button', { name: /Synced\..*Last sync/i });
        const syncStatusDot = container.querySelector('[data-sidebar-sync-dot]');

        expect(syncStatusButton).toBeInTheDocument();
        expect(syncStatusDot).toHaveClass('bg-success');
        expect(getByText('Synced')).toHaveClass('sr-only');
    });

    it('runs manual sync from the sidebar sync button', async () => {
        const showToast = vi.fn();
        const performSyncSpy = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: true,
        } as Awaited<ReturnType<typeof SyncService.performSync>>);
        act(() => {
            useUiStore.setState((state) => ({
                ...state,
                showToast,
            }));
        });

        const { getByRole } = renderLayout();

        fireEvent.click(getByRole('button', { name: /Sync now/i }));

        await waitFor(() => expect(performSyncSpy).toHaveBeenCalledTimes(1));
        expect(performSyncSpy).toHaveBeenCalledWith({ manual: true });
        expect(showToast).toHaveBeenCalledWith('Sync completed', 'success');

        performSyncSpy.mockRestore();
    });

    it('shows attachment recovery guidance instead of reporting a completed manual sync', async () => {
        const showToast = vi.fn();
        const performSyncSpy = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: true,
            attachmentWriteDeferred: true,
        } as Awaited<ReturnType<typeof SyncService.performSync>>);
        act(() => {
            useUiStore.setState((state) => ({ ...state, showToast }));
        });

        const { getByRole } = renderLayout();
        fireEvent.click(getByRole('button', { name: /Sync now/i }));

        await waitFor(() => expect(performSyncSpy).toHaveBeenCalledWith({ manual: true }));
        expect(showToast).toHaveBeenCalledWith(
            'Some attachment changes could not finish. Restore any missing local files or remove the affected attachments, then sync again.',
            'info',
            6000,
        );
        expect(showToast).not.toHaveBeenCalledWith('Sync completed', 'success');

        performSyncSpy.mockRestore();
    });

    it.each([
        {
            deferred: 'busy' as const,
            message: 'Another compatible Mindwtr device is updating this sync location. Wait for it to finish, then sync again.',
        },
        {
            deferred: 'cleanup' as const,
            message: 'The sync operation completed. Mindwtr could not remove the temporary sync lock, but it expires automatically. No retry is needed.',
        },
    ])('explains a $deferred remote fence without reporting false success or failure', async ({ deferred, message }) => {
        const showToast = vi.fn();
        const performSyncSpy = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: true,
            remoteFenceDeferred: deferred,
        } as Awaited<ReturnType<typeof SyncService.performSync>>);
        act(() => {
            useUiStore.setState((state) => ({ ...state, showToast }));
        });

        const { getByRole } = renderLayout();
        fireEvent.click(getByRole('button', { name: /Sync now/i }));

        await waitFor(() => expect(performSyncSpy).toHaveBeenCalledWith({ manual: true }));
        expect(showToast).toHaveBeenCalledWith(message, 'info', 6000);
        expect(showToast).not.toHaveBeenCalledWith('Sync completed', 'success');

        performSyncSpy.mockRestore();
    });

    it.each([
        {
            deferred: 'busy' as const,
            message: 'Another Mindwtr operation is using File Sync. Wait for it to finish; Mindwtr will retry automatically.',
        },
        {
            deferred: 'cleanup' as const,
            message: 'Sync completed, but Mindwtr could not release the File Sync lock. Restart Mindwtr before syncing again. No retry is needed.',
        },
    ])('explains a $deferred File Sync lock without reporting false success or failure', async ({ deferred, message }) => {
        const showToast = vi.fn();
        const performSyncSpy = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: true,
            fileSyncLockDeferred: deferred,
        } as Awaited<ReturnType<typeof SyncService.performSync>>);
        act(() => {
            useUiStore.setState((state) => ({ ...state, showToast }));
        });

        const { getByRole } = renderLayout();
        fireEvent.click(getByRole('button', { name: /Sync now/i }));

        await waitFor(() => expect(performSyncSpy).toHaveBeenCalledWith({ manual: true }));
        expect(showToast).toHaveBeenCalledWith(message, 'info', 6000);
        expect(showToast).not.toHaveBeenCalledWith('Sync completed', 'success');

        performSyncSpy.mockRestore();
    });

    it('shows localized recovery guidance when safe File Sync locking is unavailable', async () => {
        const showToast = vi.fn();
        const performSyncSpy = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: false,
            fileSyncLockUnavailable: true,
        } as Awaited<ReturnType<typeof SyncService.performSync>>);
        act(() => {
            useUiStore.setState((state) => ({ ...state, showToast }));
        });

        const { getByRole } = renderLayout();
        fireEvent.click(getByRole('button', { name: /Sync now/i }));

        await waitFor(() => expect(showToast).toHaveBeenCalledWith(
            'Mindwtr cannot safely lock this File Sync location. Re-select the folder, restart or update Mindwtr, or use WebDAV.',
            'error',
            6000,
        ));
        performSyncSpy.mockRestore();
    });

    it('shows an error toast when the remote write was deferred despite success:true', async () => {
        const showToast = vi.fn();
        const performSyncSpy = vi.spyOn(SyncService, 'performSync').mockResolvedValue({
            success: true,
            remoteWriteDeferred: true,
            error: 'Remote write failed. Retrying in the background.',
        } as Awaited<ReturnType<typeof SyncService.performSync>>);
        act(() => {
            useUiStore.setState((state) => ({
                ...state,
                showToast,
            }));
        });

        const { getByRole } = renderLayout();

        fireEvent.click(getByRole('button', { name: /Sync now/i }));

        await waitFor(() => expect(performSyncSpy).toHaveBeenCalledTimes(1));
        expect(showToast).toHaveBeenCalledWith('Remote write failed. Retrying in the background.', 'error');

        performSyncSpy.mockRestore();
    });

    it('shows a toast when a new sync conflict status is present', () => {
        const showToast = vi.fn();
        act(() => {
            useUiStore.setState((state) => ({
                ...state,
                showToast,
            }));
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:00:00.000Z',
                    lastSyncStatus: 'conflict',
                },
            }));
        });

        renderLayout();

        expect(showToast).toHaveBeenCalledWith(
            'Sync conflict resolved with last-write-wins. Open Settings → Sync to review the details.',
            'info',
            6000,
        );
    });

    it('does not repeat the same conflict toast when only the sync timestamp changes', async () => {
        const showToast = vi.fn();
        act(() => {
            useUiStore.setState((state) => ({
                ...state,
                showToast,
            }));
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:00:00.000Z',
                    lastSyncStatus: 'conflict',
                    lastSyncStats: createMergeStats(['task-1']),
                },
            }));
        });

        renderLayout();

        expect(showToast).toHaveBeenCalledTimes(1);

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:01:00.000Z',
                    lastSyncStatus: 'conflict',
                    lastSyncStats: createMergeStats(['task-1']),
                },
            }));
        });

        await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));

        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:02:00.000Z',
                    lastSyncStatus: 'conflict',
                    lastSyncStats: createMergeStats(['task-2']),
                },
            }));
        });

        await waitFor(() => expect(showToast).toHaveBeenCalledTimes(2));
    });

    it('stays quiet about a stale persisted conflict when sync is turned off', () => {
        const showToast = vi.fn();
        vi.spyOn(SyncService, 'getSyncStatus').mockReturnValue({
            inFlight: false,
            queued: false,
            step: null,
            lastResult: null,
            lastResultAt: null,
            backend: 'off',
        });
        act(() => {
            useUiStore.setState((state) => ({
                ...state,
                showToast,
            }));
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-04-22T12:00:00.000Z',
                    lastSyncStatus: 'conflict',
                },
            }));
        });

        renderLayout();

        expect(showToast).not.toHaveBeenCalled();
    });

    it('hides the footer sync controls while sync is turned off', () => {
        vi.spyOn(SyncService, 'getSyncStatus').mockReturnValue({
            inFlight: false,
            queued: false,
            step: null,
            lastResult: null,
            lastResultAt: null,
            backend: 'off',
        });

        const { queryByRole, container } = renderLayout();

        expect(queryByRole('button', { name: /Sync now/i })).toBeNull();
        expect(container.querySelector('[data-sidebar-sync-status]')).toBeNull();
    });

    it('reports "sync is turned off" instead of a fake completed sync', async () => {
        const showToast = vi.fn();
        const performSpy = vi
            .spyOn(SyncService, 'performSync')
            .mockResolvedValue({ success: true, skipped: 'disabled' });
        act(() => {
            useUiStore.setState((state) => ({
                ...state,
                showToast,
            }));
        });

        const { getByRole } = renderLayout();

        await act(async () => {
            fireEvent.click(getByRole('button', { name: /Sync now/i }));
        });

        expect(performSpy).toHaveBeenCalledWith({ manual: true });
        expect(showToast).toHaveBeenCalledWith('Sync is turned off', 'info');
        expect(showToast).not.toHaveBeenCalledWith('Sync completed', 'success');
    });
});

describe('Layout collapsed sidebar area filter', () => {
    it('keeps the area filter available when the sidebar is collapsed', () => {
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                _allAreas: [
                    { id: 'area-work', name: 'Work', color: '#3b82f6', order: 0, createdAt: '', updatedAt: '' },
                ],
                settings: {
                    ...state.settings,
                    sidebarCollapsed: true,
                    filters: {
                        ...(state.settings?.filters ?? {}),
                        areaId: 'area-work',
                    },
                },
            }));
        });

        const { getByRole } = renderLayout();

        expect(getByRole('button', { name: 'Area filter: Work' })).toBeInTheDocument();
    });

    it('uses distinct collapsed icons for board navigation and area filtering', () => {
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    sidebarCollapsed: true,
                },
            }));
        });

        const { container, getByRole } = renderLayout();
        const boardIcon = container.querySelector('[data-view="board"] svg');
        const areaFilterIcon = getByRole('button', { name: 'Area filter: All areas' }).querySelector('svg');

        expect(boardIcon).toHaveClass('lucide-kanban');
        expect(areaFilterIcon).toHaveClass('lucide-layers');
    });
});

describe('Layout sync security warning', () => {
    it('shows a cleartext HTTP banner for WebDAV sync', async () => {
        const backendSpy = vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue('webdav');
        const webdavSpy = vi.spyOn(SyncService, 'getWebDavConfig').mockResolvedValue({
            url: 'http://192.168.1.50/dav',
            username: '',
            hasPassword: false,
            allowInsecureHttp: true,
        });

        try {
            const { findByText } = renderLayout();

            expect(await findByText(/WebDAV sync is using HTTP/)).toBeInTheDocument();
        } finally {
            backendSpy.mockRestore();
            webdavSpy.mockRestore();
        }
    });

    it('shows a cleartext HTTP banner for active self-hosted sync', async () => {
        const backendSpy = vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue('cloud');
        const webdavSpy = vi.spyOn(SyncService, 'getWebDavConfig').mockResolvedValue({
            url: 'http://192.168.1.50/dav',
            username: '',
            hasPassword: false,
            allowInsecureHttp: true,
        });
        const providerSpy = vi.spyOn(SyncService, 'getCloudProvider').mockResolvedValue('selfhosted');
        const cloudSpy = vi.spyOn(SyncService, 'getCloudConfig').mockResolvedValue({
            url: 'http://192.168.1.50:3000',
            token: '',
            allowInsecureHttp: true,
        });

        try {
            const { findByText, queryByText } = renderLayout();

            expect(await findByText(/Self-hosted sync is using HTTP/)).toBeInTheDocument();
            expect(queryByText(/WebDAV sync is using HTTP/)).not.toBeInTheDocument();
        } finally {
            backendSpy.mockRestore();
            webdavSpy.mockRestore();
            providerSpy.mockRestore();
            cloudSpy.mockRestore();
        }
    });

    // Loopback HTTP never leaves the machine and is auto-allowed without the
    // insecure toggle, so a permanent banner for it is pure noise (discussion #1001).
    it('shows no cleartext banner for loopback HTTP WebDAV sync', async () => {
        const configurationSpy = vi.spyOn(
            SyncService,
            'getPersistedSyncConfigurationSnapshot',
        ).mockResolvedValue({
            backend: 'webdav',
            syncPath: '',
            webdav: {
                url: 'http://127.0.0.1:9328/Mindwtr',
                username: '',
                password: null,
                passwordAuthority: 'opaque',
                hasPassword: false,
                allowInsecureHttp: false,
                allowWeakFingerprint: false,
            },
            cloudProvider: 'selfhosted',
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque',
                allowInsecureHttp: false,
                rememberToken: false,
            },
        });

        try {
            const { queryByText } = renderLayout();

            await waitFor(() => expect(configurationSpy).toHaveBeenCalledTimes(1));
            expect(queryByText(/WebDAV sync is using HTTP/)).not.toBeInTheDocument();
        } finally {
            configurationSpy.mockRestore();
        }
    });

    it('ignores stale cleartext WebDAV settings while file sync is active', async () => {
        const configurationSpy = vi.spyOn(
            SyncService,
            'getPersistedSyncConfigurationSnapshot',
        ).mockResolvedValue({
            backend: 'file',
            syncPath: '/tmp/sync',
            webdav: {
                url: 'http://192.168.1.50/dav',
                username: '',
                password: null,
                passwordAuthority: 'opaque',
                hasPassword: false,
                allowInsecureHttp: true,
                allowWeakFingerprint: false,
            },
            cloudProvider: 'selfhosted',
            cloud: {
                url: 'http://192.168.1.50:3000',
                token: null,
                tokenAuthority: 'opaque',
                allowInsecureHttp: true,
                rememberToken: false,
            },
        });

        try {
            const { queryByText } = renderLayout();

            await waitFor(() => expect(configurationSpy).toHaveBeenCalledTimes(1));
            expect(queryByText(/WebDAV sync is using HTTP/)).not.toBeInTheDocument();
            expect(queryByText(/Self-hosted sync is using HTTP/)).not.toBeInTheDocument();
        } finally {
            configurationSpy.mockRestore();
        }
    });

    // This nav item is the only place a task dragged out of a list can be dropped,
    // and it gave no sign of that while a drag was in flight, so the capability was
    // undiscoverable (#867).
    it('lights up every drop target while a task drag is in flight', () => {
        const { container, getByRole } = renderLayout();
        const calendarItem = getByRole('button', { name: 'Calendar' });
        const somedayItem = container.querySelector('[data-view="someday"]')!;
        const projectsItem = container.querySelector('[data-view="projects"]')!;
        expect(calendarItem.className).not.toContain('outline-dashed');

        dispatchDragStartFromRow(true);

        // Every destination, not just whichever one the pointer happens to be over.
        expect(calendarItem.className).toContain('outline-dashed');
        expect(somedayItem.className).toContain('outline-dashed');
        // Projects is not a destination and must stay quiet.
        expect(projectsItem.className).not.toContain('outline-dashed');

        dispatchDrag('dragend', true);
        expect(calendarItem.className).not.toContain('outline-dashed');

        // An unrelated drag (text, a file) must not advertise anything.
        dispatchDragStartFromRow(false);
        expect(calendarItem.className).not.toContain('outline-dashed');
    });

    it('reclassifies a task dropped on a status list, with undo', async () => {
        const moveTask = vi.fn().mockResolvedValue({ success: true });
        const task = { id: 'task-1', title: 'Buy milk', status: 'inbox' };
        useTaskStore.setState({
            tasks: [task],
            _allTasks: [task],
            _tasksById: new Map([[task.id, task]]),
            moveTask,
            settings: {},
        } as never);

        const { container } = renderLayout();
        const dataTransfer = {
            types: [CALENDAR_TASK_DRAG_MIME],
            getData: (type: string) => (type === CALENDAR_TASK_DRAG_MIME ? 'task-1' : ''),
            dropEffect: 'none',
        };

        fireEvent.drop(container.querySelector('[data-view="waiting"]')!, { dataTransfer });

        await waitFor(() => expect(moveTask).toHaveBeenCalledWith('task-1', 'waiting'));
        const latestToast = () => {
            const toasts = useUiStore.getState().toasts;
            return toasts[toasts.length - 1];
        };
        await waitFor(() => expect(latestToast()?.action?.label).toBe('Undo'));

        // Undo puts it back where it came from.
        latestToast()!.action!.onClick();
        expect(moveTask).toHaveBeenLastCalledWith('task-1', 'inbox');
    });

    // Trash is deliberately not a drop target: a stray drag must never be able to
    // delete a task, unlike the reversible status moves above.
    it('ignores a task dropped on Trash', () => {
        const moveTask = vi.fn().mockResolvedValue({ success: true });
        useTaskStore.setState({
            _tasksById: new Map([['task-1', { id: 'task-1', title: 'Buy milk', status: 'inbox' }]]),
            moveTask,
            settings: {},
        } as never);

        const { container } = renderLayout();
        fireEvent.drop(container.querySelector('[data-view="trash"]')!, {
            dataTransfer: {
                types: [CALENDAR_TASK_DRAG_MIME],
                getData: () => 'task-1',
                dropEffect: 'none',
            },
        });

        expect(moveTask).not.toHaveBeenCalled();
    });

    // The drag this highlight exists for routinely ends without giving us either
    // signal: the calendar grid's own drop handler stops propagation, and the
    // spring-loaded jump to the calendar unmounts the list the drag started in, so
    // dragend fires on a detached node. Relying on those alone left the nav item
    // lit for the rest of the session (#867).
    it('clears the calendar highlight when a drag ends with no drop or dragend', () => {
        const { getByRole } = renderLayout();
        const calendarItem = getByRole('button', { name: 'Calendar' });

        dispatchDragStartFromRow(true);
        expect(calendarItem.className).toContain('outline-dashed');

        vi.useFakeTimers();
        try {
            // Nothing else arrives — no drop, no dragend, no further dragover.
            dispatchDrag('dragover', true);
            act(() => { vi.advanceTimersByTime(5_000); });
            expect(calendarItem.className).not.toContain('outline-dashed');
        } finally {
            vi.useRealTimers();
        }
    });
});
